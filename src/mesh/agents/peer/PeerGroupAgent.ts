import { PeerSource } from './PeerSource';
import { PeeringAgentBase } from './PeeringAgentBase';

import { SecureNetworkAgent, SecureNetworkEventType, ConnectionIdentityAuthEvent, 
    IdentityLocation, IdentityAuthStatus, SecureMessageReceivedEvent } from '../network/SecureNetworkAgent';


import { Agent, AgentId } from '../../service/Agent';
import { NetworkAgent, Endpoint, ConnectionId, NetworkEventType, RemoteAddressListeningEvent, 
         ConnectionStatusChangeEvent, ConnectionStatus, MessageReceivedEvent } from '../network/NetworkAgent';

import { AgentPod, AgentEvent } from '../../service/AgentPod';
import { LinkupAddress } from 'net/linkup/LinkupAddress';

import { Hash } from 'data/model';
import { Identity } from 'data/identity';
import { Logger, LogLevel } from 'util/logging';
import { Lock } from 'util/concurrency';
import { LRUCache } from 'util/caching';
import { PeerGroupState } from './PeerGroupState';

type PeerInfo = { endpoint: Endpoint, identityHash: Hash, identity?: Identity };

type PeerConnection = {
    connId: ConnectionId;
    peer: PeerInfo,
    status: PeerConnectionStatus,
    timestamp: number
};

enum PeerConnectionStatus {
    Connecting          = 'connecting',
    ReceivingConnection = 'receiving-connection',
    WaitingForOffer     = 'waiting-for-offer',
    OfferSent           = 'offer-sent',
    OfferAccepted       = 'offer-accepted',
    Ready               = 'ready'
};

// messages using during negotiation, before a connection has been secured:
// (i.e. both parties have proved they have the right identity for this peer group)

enum PeerMeshAgentMessageType  {
    PeeringOffer      = 'peering-offer',
    PeeringOfferReply = 'peering-offer-reply',
}

type PeeringOfferMessage = {
    type: PeerMeshAgentMessageType.PeeringOffer,
    content: { 
        peerGroupId: string,
        localIdentityHash: Hash
    }
};

type PeeringOfferReplyMessage = {
    type: PeerMeshAgentMessageType.PeeringOfferReply,
    content: {
        peerGroupId: string,
        accepted: boolean,
        localIdentityHash: Hash
    }
};

type PeerMeshAgentMessage = PeeringOfferMessage | PeeringOfferReplyMessage;


// secured connection: 

enum SecureMessageTypes {
    PeerMessage      = 'peer-message',
    ChooseConnection = 'choose-connection',
    ConfirmChosenConnection = 'confirm-chosen-connection'
}

type PeerMessage = { 
    type: SecureMessageTypes.PeerMessage,
    peerGroupId: string,
    agentId: AgentId, 
    content: any
}


// Sometimes two peers may end up with more than one connection established between them,
// these messages are used to agree on a connection to use and safely close the others.
type ConnectionSelectionMessage = {
    type: SecureMessageTypes.ChooseConnection | SecureMessageTypes.ConfirmChosenConnection,
    peerGroupId: string
}

type SecureMessage = PeerMessage | ConnectionSelectionMessage;


enum PeerMeshEventType {
    NewPeer  = 'new-peer',
    LostPeer = 'lost-peer'
}

type NewPeerEvent = {
    type: PeerMeshEventType.NewPeer,
    content: {
        peerGroupId: string,
        peer: PeerInfo
    }
}

type LostPeerEvent = {
    type: PeerMeshEventType.LostPeer,
    content: {
        peerGroupId: string,
        peer: PeerInfo
    }
}

type Params = {
    minPeers: number,
    maxPeers: number,
    peerConnectionTimeout: number,
    peerConnectionAttemptInterval: number,
    peerDiscoveryAttemptInterval: number,
    tickInterval: number
};

type CumulativeStats = {
    connectionInit: number;
    connectionAccpt: number;
    connectionTimeouts: number;
}

type Stats = {
    peers: number;
    connections: number;
    connectionsPerStatus: Map<PeerConnectionStatus, number>;
}

class PeerGroupAgent implements Agent {

    static controlLog = new Logger(PeerGroupAgent.name, LogLevel.INFO);
    static peersLog = new Logger(PeerGroupAgent.name, LogLevel.INFO);

    peerGroupId: string;
    localPeer: PeerInfo;

    peerSource: PeerSource;

    connections: Map<ConnectionId, PeerConnection>;
    connectionsPerEndpoint: Map<Endpoint, Array<ConnectionId>>;

    instanceIdPerEndpoint: Map<Endpoint, string>;

    peerDiscoveryTimestamp?: number;

    connectionAttemptTimestamps: Map<Endpoint, number>;
    onlineQueryTimestamps: LRUCache<Endpoint, number>;// Map<Endpoint, number>;
    chosenForDeduplication: Map<Endpoint, ConnectionId>;

    pod?: AgentPod;

    params: Params;

    tick: () => Promise<void>;
    tickTimerRef: any;

    stats: CumulativeStats;

    controlLog = PeerGroupAgent.controlLog;
    peersLog = PeerGroupAgent.peersLog;

    tickLock: Lock;

    startup = Date.now();
    firstPeer?: number;

    constructor(peerGroupId: string, localPeer: PeerInfo, peerSource: PeerSource, params?: Partial<Params>) {
        this.peerGroupId = peerGroupId;
        this.localPeer = localPeer;
        
        this.peerSource = peerSource;

        this.connections = new Map();
        this.connectionsPerEndpoint = new Map();

        this.instanceIdPerEndpoint = new Map();

        this.connectionAttemptTimestamps = new Map();
        this.onlineQueryTimestamps = new LRUCache(128);
        this.chosenForDeduplication = new Map();

        if (params === undefined) {
            params = { };
        }

        this.params = {
            minPeers: params.minPeers || 3,
            maxPeers: params.maxPeers || 12,
            peerConnectionTimeout: params.peerConnectionTimeout || 20,
            peerConnectionAttemptInterval: params.peerConnectionAttemptInterval || 10,
            peerDiscoveryAttemptInterval: params.peerDiscoveryAttemptInterval || 15,
            tickInterval: params.tickInterval || 30
        };

        this.tick = async () => {

            if (this.tickLock.acquire()) {
                try {

                    //console.log(this.peerGroupId + ' has ' + this.getPeers().length + ' peers')

                    this.cleanUp();
                    await this.queryForOnlinePeers();
                    this.deduplicateConnections();
                    await this.checkPeers();
                } finally {
                    this.tickLock.release();
                }
    
            }

        };

        this.tickLock = new Lock();


        this.stats = { connectionInit: 0, connectionAccpt: 0, connectionTimeouts: 0 };
    }

    getAgentId(): string {
        return PeerGroupAgent.agentIdForPeerGroup(this.peerGroupId);
    }

    getTopic(): string {
        return this.peerGroupId;
    }

    getLocalPeer(): PeerInfo {
        return this.localPeer;
    }

    ready(pod: AgentPod): void {
        this.controlLog.debug(this.peerGroupId + '/' + this.localPeer.endpoint + ': Started PeerControlAgent (id=' + this.localPeer.identityHash + ')');
        this.pod = pod;
        this.startup = Date.now();
        this.init();
    }


    private async init() {

        const networkAgent = this.getNetworkAgent();

        networkAgent.listen(this.localPeer.endpoint, this.localPeer.identity);

        for(const ci of this.getNetworkAgent().getAllConnectionsInfo()) {
            if (ci.localEndpoint === this.localPeer.endpoint && 
                this.getNetworkAgent().checkConnection(ci.connId)) {

                let peer = await this.peerSource.getPeerForEndpoint(ci.remoteEndpoint);

                if (this.shouldConnectToPeer(peer)) {
                    this.getNetworkAgent().acceptConnection(ci.connId, this.getAgentId());
                    let pc = this.addPeerConnection(ci.connId, peer as PeerInfo, PeerConnectionStatus.OfferSent);
                    
                    this.sendOffer(pc);
                }
            }
        }

        this.queryForOnlinePeers();
        this.tickTimerRef = setInterval(this.tick, this.params.tickInterval * 1000);

    }

    getPeers() : Array<PeerInfo> {
        
        let seen = new Set<Endpoint>();
        let unique = new Array<PeerInfo>();
        for (const pc of this.connections.values()) {
            if (pc.status === PeerConnectionStatus.Ready && !seen.has(pc.peer.endpoint)) {
                unique.push(pc.peer);
                seen.add(pc.peer.endpoint);
            }
        }

        return unique;
    }

    isPeer(ep: Endpoint){
        return this.findWorkingConnectionId(ep, false) !== undefined;
    }

    validateConnectedPeer(ep: Endpoint) : boolean {
        let connId = this.findWorkingConnectionId(ep);
        return connId !== undefined;
    }

    // Peer messaging functions, to be used by other local agents:

    sendToAllPeers(agentId: AgentId, content: any): number {
        let count=0;
        
        for (let ep of this.connectionsPerEndpoint.keys()) {
            if (this.sendToPeer(ep, agentId, content)) {
                count = count + 1;
            }
        }

        this.controlLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint + ': sending message to all (' + count + ') peers.');

        return count;
    }

    sendToPeer(ep: Endpoint, agentId: AgentId, content: any): boolean {
        
        let connId = this.findWorkingConnectionId(ep);
        
        if (connId !== undefined) {

            try {
                let pc = this.connections.get(connId) as PeerConnection;

                let peerMsg: PeerMessage = {
                    type: SecureMessageTypes.PeerMessage,
                    peerGroupId: this.peerGroupId,
                    agentId: agentId,
                    content: content
                };
    
                let secureConnAgent = this.getSecureConnAgent();
                secureConnAgent.sendSecurely(
                    connId, 
                    this.localPeer.identityHash, 
                    pc.peer.identityHash, 
                    this.getAgentId(), 
                    peerMsg
                );
    
                this.controlLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint + ': sending peer message to ' + ep + ' for agent ' + agentId + ' over connection ' + connId);
                return true;    
            } catch (e) {

                this.controlLog.warning(this.peerGroupId + '/' + this.localPeer.endpoint + ' (for agent ' + agentId + '): Could not send message to ' + ep + ': error', e);
                return false;
            }
        } else {
            this.controlLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint  + ' (for agent ' + agentId + '): could not send peer message to ' + ep);
            return false;
        }
    }

    peerSendBufferIsEmpty(ep: Endpoint): boolean {
        let connId = this.findWorkingConnectionId(ep);

        if (connId !== undefined) {
            return this.getNetworkAgent().connectionSendBufferIsEmpty(connId);
        } else {
            return false;
        }
    }

    getStats() : Stats {
        let stats: Stats = {
            peers: 0,
            connections: this.connections.size,
            connectionsPerStatus: new Map()
        };

        for (const ep of this.connectionsPerEndpoint.keys()) {
            if (this.findWorkingConnectionId(ep) !== undefined) {
                stats.peers += 1;
            }
        }

        for (const conn of this.connections.values()) {
            let c = stats.connectionsPerStatus.get(conn.status);
            if (c === undefined) {
                c = 0;
            }
            stats.connectionsPerStatus.set(conn.status, c + 1);
        }

        return stats;
    }

    // Clean-up & new connection starting functions, called from the periodic tick

    private cleanUp() {


        let now = Date.now();

        // Remove connections that:
        //   1. are ready, but the connection has been lost
        //   2. are not ready, and the connection timeout has elapsed
        for (const pc of Array.from(this.connections.values())) {
            if (pc.status === PeerConnectionStatus.Ready) {
                if (!this.getNetworkAgent().checkConnection(pc.connId)) {
                    this.removePeerConnection(pc.connId);
                    this.getNetworkAgent().releaseConnectionIfExists(pc.connId, this.getAgentId()); // SANTI NEW
                }
            } else {                
                if (now > pc.timestamp + this.params.peerConnectionTimeout * 1000) {
                    this.stats.connectionTimeouts += 1;
                    this.removePeerConnection(pc.connId);
                    this.getNetworkAgent().releaseConnectionIfExists(pc.connId, this.getAgentId()); // SANTI NEW
                }
            }
        }

        // Remove connection attempt timestamps that are too old to make a difference.
        // (i.e. peerConnectionAttemptInterval has already elapsed and we can try to reconnect)
        for (const [endpoint, timestamp] of Array.from(this.connectionAttemptTimestamps.entries())) {
            if (now > timestamp + this.params.peerConnectionAttemptInterval * 1000) {
                this.connectionAttemptTimestamps.delete(endpoint);
            }
        };

    }

    private async queryForOnlinePeers() {

        const now = Date.now();

        const peerDiscoveryAdjust = this.connectionsPerEndpoint.size < this.params.minPeers && now < this.startup + 20000? 0.05 : 1; 

        if (this.peerDiscoveryTimestamp === undefined || now > this.peerDiscoveryTimestamp + peerDiscoveryAdjust * this.params.peerDiscoveryAttemptInterval * 1000) {

            this.peerDiscoveryTimestamp = now;
            this.peersLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint + ': considering querying for peers');

            if (this.connectionsPerEndpoint.size < this.params.minPeers) {
                let candidates = await this.peerSource.getPeers(this.params.minPeers * 5);
                let endpoints = new Array<Endpoint>();
                let fallbackEndpoints = new Array<Endpoint>();
                const now = Date.now();
    
                this.peersLog.debug(this.peerGroupId + '/' + this.localPeer.endpoint + ': looking for peers, got ' + candidates.length + ' candidates');
                this.peersLog.trace(candidates.map((k: PeerInfo) => k.endpoint + '--> ' + k.identityHash ));
    
                for (const candidate of candidates) {
    
                    if (this.localPeer.endpoint === candidate.endpoint) {
                        continue;
                    }
    
                    if (this.connectionsPerEndpoint.get(candidate.endpoint) !== undefined) {
                        continue;
                    }
    
                    const lastQueryTimestamp = this.onlineQueryTimestamps.get(candidate.endpoint);
                    if (lastQueryTimestamp !== undefined &&
                        now < lastQueryTimestamp + peerDiscoveryAdjust * this.params.peerConnectionAttemptInterval * 1000) {
    
                        continue;
                    }
    
                    const lastAttemptTimestamp = this.connectionAttemptTimestamps.get(candidate.endpoint);
    
                    if (fallbackEndpoints.length < this.params.minPeers - this.connectionsPerEndpoint.size) {
                        fallbackEndpoints.push(candidate.endpoint);
                    }
    
                    if (lastAttemptTimestamp !== undefined &&
                        now < lastAttemptTimestamp + peerDiscoveryAdjust * this.params.peerConnectionAttemptInterval * 1000) {
    
                        continue
                    }
    
                    // we haven't queried nor attempted to connect to this endpoint recently, 
                    // and we are not connected / connecting now, so query:
                    endpoints.push(candidate.endpoint);
    
                    if (endpoints.length >= this.params.minPeers - this.connectionsPerEndpoint.size) {
                        break;
                    }
                }
    
                if (endpoints.length < this.params.minPeers) {
                    endpoints = fallbackEndpoints;
                }
    
                for (const endpoint of endpoints) {
                    this.onlineQueryTimestamps.set(endpoint, now);
                }
    
                if (endpoints.length > 0) {
                    this.peersLog.debug(this.peerGroupId + '/' + this.localPeer.endpoint + ': is querying for online endpoints: '  + endpoints);
    
                    this.getNetworkAgent().queryForListeningAddresses(
                                        LinkupAddress.fromURL(this.localPeer.endpoint), 
                                        endpoints.map((ep: Endpoint) => LinkupAddress.fromURL(ep)));
                }
    
                
            } else {
                this.peersLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint + ': skipping querying for peers');
            }

        }

        
    }

    private async checkPeers() {
        for (const [endpoint, connIds] of this.connectionsPerEndpoint.entries()) {
            if (await this.peerSource.getPeerForEndpoint(endpoint) === undefined) {
                for (const connId of connIds) {
                    try {
                        this.getNetworkAgent().releaseConnectionIfExists(connId, this.getAgentId());
                    } catch (e) {
                        PeerGroupAgent.controlLog.warning('Error attempting to release connection ' + connId, e);
                    }
                }
            }
        }

    }

    // Connection deduplication logic.

    // Note: ATM the PeerGroupAgent will aggressively deduplicate all connections that go to the
    //       same endpoint. In the future, we could use the "instanceId" field in the NetworkAgent's
    //       connectionInfo to tell when these connections are actually going to the same devices 
    //       (besides belonging to the same identity), and may not prune connections up to a given
    //       number of different devices.

    private deduplicateConnections() {
        
        for (const [endpoint, connIds] of this.connectionsPerEndpoint.entries()) {

            if (connIds.length > 1) {

                // Check if there was a chosen connection.
                let chosenConnId = this.chosenForDeduplication.get(endpoint);
    
                // And in that case, if it is still working.
                if (chosenConnId !== undefined &&
                    !this.getNetworkAgent().checkConnection(chosenConnId)) {
                        
                    chosenConnId = undefined;
                    this.chosenForDeduplication.delete(endpoint);
                    
                }

                
                if (chosenConnId === undefined) {

                    let ready = [];

                    for (const connId of connIds) {
                        let pc = this.connections.get(connId);
                        if (pc !== undefined && pc.status === PeerConnectionStatus.Ready && 
                            this.getNetworkAgent().checkConnection(connId)) {
                            
                            ready.push(connId);
                        }
                    }
    
                    
    
                    if (ready.length > 1) {
                        PeerGroupAgent.controlLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint + ': Connection duplication detected (' + ready.length + ') to ' + endpoint);
                        ready.sort();
                        chosenConnId = ready[0];
                        this.chosenForDeduplication.set(endpoint, chosenConnId);
                        this.sendChosenConnection(chosenConnId);
                    }
                }

            }

            
        }

    }

    getState(): PeerGroupState {

        const remote = new Map<Endpoint, PeerInfo>();

        for (const ep of this.connectionsPerEndpoint.keys()) {
            const connId = this.findWorkingConnectionId(ep);
            const conn   = connId === undefined? undefined : this.connections.get(connId);
            if (conn !== undefined) {
                remote.set(ep, conn.peer);
            }
        }

        return {
            local: this.localPeer,
            remote: remote
        };
    }

    shutdown() {
        if (this.tickTimerRef !== undefined) {
            clearInterval(this.tickTimerRef);
            this.tickTimerRef = undefined;
        }
    }

    // Deduplication messages.

    private sendChosenConnection(chosenConnId: ConnectionId) {

        this.sendConnectionSelectionMessage(chosenConnId, SecureMessageTypes.ChooseConnection);
    }

    private sendChosenConnectionConfirmation(chosenConnId: ConnectionId) {

        this.sendConnectionSelectionMessage(chosenConnId, SecureMessageTypes.ConfirmChosenConnection);
    }

    private sendConnectionSelectionMessage(chosenConnId: ConnectionId, type: (SecureMessageTypes.ChooseConnection | SecureMessageTypes.ConfirmChosenConnection)) {
        let connSelectionMsg: ConnectionSelectionMessage = {
            type: type,
            peerGroupId: this.peerGroupId,
        };

        let pc = this.connections.get(chosenConnId) as PeerConnection;
        let secureConnAgent = this.getSecureConnAgent();

        secureConnAgent.sendSecurely(
            chosenConnId, 
            this.localPeer.identityHash,
            pc.peer.identityHash,
            this.getAgentId(), 
            connSelectionMsg
        );
    }

    // Actual deduplication, when peers have agreed on which connection to keep.

    private chooseConnection(chosenConnId: ConnectionId) {

        let pc = this.connections.get(chosenConnId) as PeerConnection;

        let allConnIds = this.connectionsPerEndpoint.get(pc.peer.endpoint);

        if (allConnIds !== undefined) {
            for (const connId of allConnIds) {
                if (connId !== chosenConnId) {
                    PeerGroupAgent.controlLog.debug(this.peerGroupId + '/' + this.localPeer.endpoint + ': Closing connection due to deduplication: ' + connId + ' (the chosen one is ' + chosenConnId + ')');
                    this.getNetworkAgent().releaseConnection(connId, this.getAgentId());
                    this.removePeerConnection(connId);
                }
            }
        }
    }

    // Connection handling: find a working connecton to an ep, decide whether to connect to or accept a
    //                      connection from a potential peer.

    private findWorkingConnectionId(ep: Endpoint, validate=true) : ConnectionId | undefined {
        let connIds = this.connectionsPerEndpoint.get(ep);

        if (connIds !== undefined) {

            for (let connId of connIds) {

                let pc = this.connections.get(connId);

                if (pc !== undefined && 
                    pc.status === PeerConnectionStatus.Ready && 
                    (!validate || this.getNetworkAgent().checkConnection(connId))) {
                        return connId;
                }

            }

        } 
        
        return undefined; // no luck

    }


    // Returns a peer corresponding to ep if we should connect, undefined otherwse.
    private shouldConnectToPeer(p?: PeerInfo) : boolean {

        if (p !== undefined &&                                           // - p is a peer
            this.connectionsPerEndpoint.size < this.params.minPeers &&   // - we're below minimum peers
            this.connectionsPerEndpoint.get(p.endpoint) === undefined && // - we're not connect[ed/ing] to ep
            this.localPeer.endpoint !== p.endpoint) {                    // - ep is not us
                                                                         // ====> then init conn. to ep

            const lastAttemptTimestamp = this.connectionAttemptTimestamps.get(p.endpoint);
            const now = Date.now();

            // check if we have to wait because we've attempted to connect to ep recently.
            if (lastAttemptTimestamp === undefined || 
                now > lastAttemptTimestamp + this.params.peerConnectionAttemptInterval * 1000) {
                
                // OK just do it.
                return true;
            } else {
                PeerGroupAgent.controlLog.trace('Will not connect, there is a recent connection attempt to the same endpoint.');
            }
        } else {
            PeerGroupAgent.controlLog.trace(
                () => this.peerGroupId + '/' + this.localPeer.endpoint + ': will not connect, resons: ' + 
                '\np!==undefined => ' + (p !== undefined) + 
                '\nthis.connectionsPerEndpoint.size < this.params.minPeers => ' + (this.connectionsPerEndpoint.size < this.params.minPeers) + 
                '\nthis.connectionsPerEndpoint.get(p.endpoint) === undefined => ' + (p !== undefined && this.connectionsPerEndpoint.get(p.endpoint) === undefined) + 
                '\nthis.localPeer.endpoint !== p.endpoint => ' + (p !== undefined && this.localPeer.endpoint !== p.endpoint));
        }

        // if conditions above are not met, don't connect.
        return false;
    }

    // Returns a peer corresponding to ep if we should accept the connection, undefined otherwise
    private shouldAcceptPeerConnection(connId: ConnectionId, p?: PeerInfo) {

        if (p === undefined) {
            return false;
        } else {
            const conns = this.connectionsPerEndpoint.get(p.endpoint);
            const alreadyConnected = conns !== undefined && conns.length > 0;

            const isSameInstance = this.checkConnectionRemoteInstance(connId);

            return (this.connectionsPerEndpoint.size + (alreadyConnected? 0 : 1) <= this.params.maxPeers && // - we're below maximum peers
                    this.findWorkingConnectionId(p.endpoint) === undefined &&                               // - there's not a working conn to ep
                    this.localPeer.endpoint !== p.endpoint &&                                               // - ep is not us
                    isSameInstance);                                                                        // - if we're connected to an instance already, respect it
        }
                                                                       
    }

    // Connection metadata: create / destroy a new PeerConnection

    private addPeerConnection(connId: ConnectionId, peer: PeerInfo, status: PeerConnectionStatus) {

        const existing = this.connections.get(connId);

        if (existing !== undefined) {
            PeerGroupAgent.controlLog.warning(this.peerGroupId + '/' + this.localPeer.endpoint + ': Trying to add connection ' + connId + ', but it already exists.');
            PeerGroupAgent.controlLog.warning('old status: ' + existing.status + ', new status: ' + status);

            //existing.status = status; // confused about this

            return existing;
        } else {

            if (this.attemptToSetRemoteInstance(connId)) {
                let pc: PeerConnection = {
                    connId: connId,
                    peer: peer,
                    status: status,
                    timestamp: Date.now()
                };
    
                this.connections.set(connId, pc);
                let conns = this.connectionsPerEndpoint.get(peer.endpoint);
                if (conns === undefined) {
                    conns = [];
                    this.connectionsPerEndpoint.set(peer.endpoint, conns);
                }
    
                conns.unshift(connId);
    
                return pc;
            } else {
                PeerGroupAgent.controlLog.error(this.peerGroupId + '/' + this.localPeer.endpoint + ': Trying to add connection ' + connId + ', but already connected to a different instance');
                throw new Error('Trying to add connection ' + connId + ', but already connected to a different instance');
            }

            
        }
    }

    private removePeerConnection(connId: ConnectionId) {
        let pc = this.connections.get(connId);

        if (pc !== undefined) {
            this.connections.delete(connId);

            let conns = this.connectionsPerEndpoint.get(pc.peer.endpoint);
            if (conns !== undefined) {
                let idx = conns.indexOf(connId);
                if (idx >= 0) {
                    conns.splice(idx, 1);
                }

                if (conns.length === 0) {
                    this.connectionsPerEndpoint.delete(pc.peer.endpoint);
                    conns = undefined;
                }
            }
            
            if (pc.status === PeerConnectionStatus.Ready && conns === undefined ) {
                this.instanceIdPerEndpoint.delete(pc.peer.endpoint);
                this.broadcastLostPeerEvent(pc.peer);
            }
        }
    }

    // Ask SecureConnectionAgent to secure a connection, given local and remote identities

    private secureConnection(pc: PeerConnection) {

        //if (this.firstPeer === undefined) {
        //    console.log('asking for connection securing took ' + (Date.now() - this.startup) + ' ms');
        //}

        const secureConnAgent = this.getSecureConnAgent();

        secureConnAgent.secureForReceiving(pc.connId, this.localPeer.identity as Identity);
        secureConnAgent.secureForSending(pc.connId, pc.peer.identityHash, pc.peer.identity); 
    }
    
    private checkSecuredConnection(pc: PeerConnection) {

        const secureConnAgent = this.getSecureConnAgent();

        let localId  = secureConnAgent.getLocalVerifiedIdentity(pc.connId, this.localPeer.identityHash);
        let remoteId = secureConnAgent.getRemoteVerifiedIdentity(pc.connId, pc.peer.identityHash);

        let success = (localId !== undefined && remoteId !== undefined);

        pc.peer.identity = remoteId;

        return success;
    }
    

    // handling of events for peer connection negotiation:

    private async onOnlineEndpointDiscovery(ep: Endpoint) {

        const queryStart = this.onlineQueryTimestamps.get(ep);
        const queryTime  = queryStart === undefined? 'unknown' : (Date.now()-queryStart) + 'ms';

        this.controlLog.debug(this.peerGroupId + '/' + this.localPeer.endpoint + ': has discovered that ' + ep + ' is online. Query time: ' + queryTime);

        
        let peer = await this.peerSource.getPeerForEndpoint(ep);
        
        if (this.shouldConnectToPeer(peer)) {
            this.controlLog.debug(this.peerGroupId + '/' + this.localPeer.endpoint + ': will initiate peer connection to ' + ep + '.');
            let connId = this.getNetworkAgent().connect(this.localPeer.endpoint, (peer as PeerInfo).endpoint, this.getAgentId());
            this.addPeerConnection(connId, peer as PeerInfo, PeerConnectionStatus.Connecting);
            this.connectionAttemptTimestamps.set(ep, Date.now());
            this.stats.connectionInit += 1;
        } else {
            this.controlLog.debug(this.peerGroupId + '/' + this.localPeer.endpoint + ': will NOT initiate peer connection to ' + ep + '.');
        }
    }

    private async onConnectionRequest(connId: ConnectionId, local: Endpoint, remote: Endpoint) {
        
        if (this.localPeer.endpoint === local) {
            let peer = await this.peerSource.getPeerForEndpoint(remote);

            this.controlLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint + ': receiving a conn. request from ' + remote + ', connId is ' + connId);

            if (this.shouldAcceptPeerConnection(connId, peer)) {
                this.controlLog.debug(this.peerGroupId + '/' + this.localPeer.endpoint + ': will accept requested connection ' + connId + '!');
                this.addPeerConnection(connId, peer as PeerInfo, PeerConnectionStatus.ReceivingConnection);
                this.getNetworkAgent().acceptConnection(connId, this.getAgentId());
                this.stats.connectionAccpt += 1;
            } else {
                this.controlLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint + ': will NOT accept requested connection ' + connId + '!');
            }
        }

    }

    private onConnectionEstablishment(connId: ConnectionId, local: Endpoint, remote: Endpoint) {
        let pc = this.connections.get(connId);

        this.controlLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint + ': receiving a connection from ' + remote + ' connId is ' + connId);

        if (pc !== undefined && this.localPeer.endpoint === local && pc.peer.endpoint === remote) {

            if (this.checkConnectionRemoteInstance(connId)) {
                if (pc.status === PeerConnectionStatus.Connecting) {
                    this.sendOffer(pc);
                    pc.status = PeerConnectionStatus.OfferSent;
                } else if (pc.status === PeerConnectionStatus.ReceivingConnection) {
                    pc.status = PeerConnectionStatus.WaitingForOffer;
                }
            } else {
                this.controlLog.debug(this.peerGroupId + '/' + this.localPeer.endpoint + ': rejecting a established connection from ' + remote + ', connId is ' + connId + ', because we are already connected to another instance of the same peer');
                this.removePeerConnection(connId);
                this.getNetworkAgent().releaseConnectionIfExists(connId, this.getAgentId());
            }

        } else {
            this.controlLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint + ': Unknown connection ' + connId + ', ignoring. pc=' + pc + ' local=' + local + ' remote='+ remote);
        }
    }

    private async onReceivingOffer(connId: ConnectionId, source: Endpoint, destination: Endpoint, peerGroupId: string, remoteIdentityHash: Hash) {
        
        this.controlLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint + ': receiving peering offer from ' + source);


        // do this here so we get atomicity below.
        let peer = await this.peerSource.getPeerForEndpoint(source);

        let reply  = false;
        let accept = false;
        let pc = this.connections.get(connId);
        

        // Maybe the PeerControlAgent, upong starting in another node, found an existing connection
        // to us, and wants to start a PeerConnection over it. So we have no previous state referring
        // to connection establishment, and we just receive the offer over an existing one.
        if (pc === undefined) {

            this.controlLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint + ': found no previous state for ' + connId);

            if (this.shouldAcceptPeerConnection(connId, peer)) {

                this.controlLog.debug(this.peerGroupId + '/' + this.localPeer.endpoint + ': will accept offer ' + connId + '!');
                // Act as if we had just received the connection, process offer below.
                pc = this.addPeerConnection(connId, peer as PeerInfo, PeerConnectionStatus.WaitingForOffer);
                accept = true;
                reply  = true;

            } else {

                this.controlLog.debug(this.peerGroupId + '/' + this.localPeer.endpoint + ': will NOT accept offer ' + connId + '!');
                if (peer !== undefined && 
                    peer.identityHash === remoteIdentityHash &&
                    this.peerGroupId === peerGroupId) {
                    
                    // OK, we don't want to accept, but this is, in principle, a valid peer.
                    // Send a rejection below.
                    accept = false;
                    reply  = true;
                }
            }
        } else { // pc !== undefined
                // OK, we had previous state - if everything checks up, accept.

            this.controlLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint + ': found previous state:' + pc.status);
            if (peerGroupId === this.peerGroupId &&
                (pc.status === PeerConnectionStatus.WaitingForOffer ||
                pc.status === PeerConnectionStatus.OfferSent) &&
                source === pc.peer.endpoint &&
                destination === this.localPeer.endpoint &&
                remoteIdentityHash === pc.peer.identityHash) {
                
                
                reply  = true;
                accept = this.checkConnectionRemoteInstance(connId);

                if (accept) {
                    this.controlLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint + ': everything checks out for ' + connId + '!');
                } else {
                    this.controlLog.debug(this.peerGroupId + '/' + this.localPeer.endpoint + ': dropping ' + connId + ': already connected to another instance');
                }

            } else {
                this.controlLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint + ': the request is invalid.');
            }
        }

        // If the offer was correct, we send a reply.
        // Notice: accept implies reply.

        if (reply) {
            this.sendOfferReply(connId, accept);
        }

        // Act upon the offer: if it was accepted, update local state and 
        //                     initiate connection authentication. Otherwise
        //                     clear the state on this connection.

        if (accept) {
            const apc = pc as PeerConnection;
            
            if (!this.checkSecuredConnection(apc)) {
                apc.status = PeerConnectionStatus.OfferAccepted;
                this.secureConnection(apc);
            } else {
                apc.status = PeerConnectionStatus.Ready;
                this.broadcastNewPeerEvent(apc.peer);
            }
            
        } else {
            PeerGroupAgent.controlLog.debug(this.peerGroupId + '/' + this.localPeer.endpoint + ': dropping connection ' + connId + ': offer was rejected');
            this.removePeerConnection(connId);
            this.getNetworkAgent().releaseConnectionIfExists(connId, this.getAgentId());
        }
    }

    private onReceivingOfferReply(connId: ConnectionId, source: Endpoint, destination: Endpoint, peerGroupId: string, remoteIdentityHash: Hash, accepted: boolean) {
        let pc = this.connections.get(connId);

        this.controlLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint + ': receiving offer reply from ' + source);

        if (pc !== undefined &&
            peerGroupId === this.peerGroupId &&
            pc.status === PeerConnectionStatus.OfferSent &&
            source === pc.peer.endpoint &&
            destination === this.localPeer.endpoint && 
            remoteIdentityHash === pc.peer.identityHash &&
            accepted) {

                

                if (!this.checkSecuredConnection(pc)) {
                    pc.status = PeerConnectionStatus.OfferAccepted;
                    this.secureConnection(pc);
                } else {
                    pc.status = PeerConnectionStatus.Ready;
                    this.broadcastNewPeerEvent(pc.peer);
                }
                
        }
    }

    private onConnectionAuthentication(connId: ConnectionId, identityHash: Hash, identity: Identity, identityLocation: IdentityLocation) {

        //if (this.firstPeer === undefined) {
        //    console.log('authenticated a connection in ' + (Date.now() - this.startup) + ' ms');
        //}

        let pc = this.connections.get(connId);

        identityHash; identity; identityLocation;

        if (pc !== undefined && pc.status === PeerConnectionStatus.OfferAccepted) {
            if (this.checkSecuredConnection(pc)) {
                pc.status = PeerConnectionStatus.Ready;
                this.broadcastNewPeerEvent(pc.peer);
            }
        }
    }

    private onConnectionClose(connId: ConnectionId) {
        this.removePeerConnection(connId);
    }

    // Offer / offer reply message construction, sending.

    private sendOffer(pc: PeerConnection) {
        let message: PeeringOfferMessage = {
            type: PeerMeshAgentMessageType.PeeringOffer,
            content: {
                peerGroupId: this.peerGroupId,
                localIdentityHash: this.localPeer.identityHash
            }
        };

        this.controlLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint + ': sending peering offer to ' + pc.peer.endpoint);

        this.getNetworkAgent().sendMessage(pc.connId, this.getAgentId(), message);
    }

    private sendOfferReply(connId: ConnectionId, accept: boolean) {
        let message: PeeringOfferReplyMessage = {
            type: PeerMeshAgentMessageType.PeeringOfferReply,
            content: {
                 peerGroupId: this.peerGroupId,
                 localIdentityHash: this.localPeer.identityHash,
                 accepted: accept
            }
        };

        this.controlLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint + ': sending peering offer reply to ' + this.connections.get(connId)?.peer.endpoint) + ': ' + (accept? 'ACCEPT' : 'REJECT');

        this.getNetworkAgent().sendMessage(connId, this.getAgentId(), message);
    }

    // handle peer message reception

    private onPeerMessage(connId: ConnectionId, sender: Hash, recipient: Hash, peerGroupId: string, agentId: AgentId, message: any) {
        let pc = this.connections.get(connId);

        if (peerGroupId === this.peerGroupId &&
            pc !== undefined && pc.status === PeerConnectionStatus.Ready &&
            pc.peer.identityHash === sender && this.localPeer.identityHash === recipient) {

            let agent = this.getLocalAgent(agentId);

            if (agent !== undefined && agent instanceof PeeringAgentBase) {
                let peeringAgent = agent as PeeringAgentBase;
                peeringAgent.receivePeerMessage(pc.peer.endpoint, sender, recipient, message);
            }
        }
    }

    // If two peers attempt to connect to each other nearly at the same time, they may end up with
    // two different connections between a single pair of endpoints. The following exchange allows
    // them to agree on a connection to use, and safely close the rest.

    
    private onConnectionSelection(connId: ConnectionId, sender: Hash, recipient: Hash, type: (SecureMessageTypes.ChooseConnection | SecureMessageTypes.ConfirmChosenConnection), peerGroupId: string) {
        
        connId; sender; recipient; type; peerGroupId;

        PeerGroupAgent.controlLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint + ': connection selection for ' + connId + ' sender=' + sender + ', recipient=' + recipient + ', type=' + type);

        let pc = this.connections.get(connId);

        // If connId represents an acceptable option (a working connection in Ready state):
        if (pc !== undefined && 
            pc.status === PeerConnectionStatus.Ready &&
            this.getNetworkAgent().checkConnection(connId)) {

            let accept = false;

            let chosenConnId = this.chosenForDeduplication.get(pc.peer.endpoint);
            
            // if we didn't propose another connecitons, choose this one.
            if (chosenConnId === undefined || chosenConnId === connId) {
                accept = true;
            } else {
                const options = new Array<ConnectionId>();

                options.push(connId);
                options.push(chosenConnId);
                options.sort();

                const tieBreak = options[0];
                accept = tieBreak === connId;
            }

            if (accept) {
                this.chooseConnection(connId);
                if (type === SecureMessageTypes.ChooseConnection) {
                    this.sendChosenConnectionConfirmation(connId);
                }  
            }
        }
        
    }



    /* The functions,receiveLocalEvent receives events generated by the other agents in the pod
     * and fires the appropriate event handlers defined above (onConnectionRequest, onReceivingOffer, 
     * etc.)
     */

    receiveLocalEvent(ev: AgentEvent): void {
        if (ev.type === NetworkEventType.RemoteAddressListening) {
            const listenEv = ev as RemoteAddressListeningEvent;
            
            this.onOnlineEndpointDiscovery(listenEv.content.remoteEndpoint);

        } else if (ev.type === NetworkEventType.ConnectionStatusChange) {
            const connEv = ev as ConnectionStatusChangeEvent;

            if (connEv.content.status === ConnectionStatus.Closed) {
                this.onConnectionClose(connEv.content.connId);
            } else if (connEv.content.status === ConnectionStatus.Received) {
                this.onConnectionRequest(connEv.content.connId, connEv.content.localEndpoint, connEv.content.remoteEndpoint);
            } else if (connEv.content.status === ConnectionStatus.Ready) {
                this.onConnectionEstablishment(connEv.content.connId, connEv.content.localEndpoint, connEv.content.remoteEndpoint);
            }
        } else if (ev.type === SecureNetworkEventType.ConnectionIdentityAuth) {
            let connAuth = ev as ConnectionIdentityAuthEvent;

            if (connAuth.content.status === IdentityAuthStatus.Accepted) {
                this.onConnectionAuthentication(connAuth.content.connId, connAuth.content.identityHash, connAuth.content.identity as Identity, connAuth.content.identityLocation);
            }
        } else if (ev.type === SecureNetworkEventType.SecureMessageReceived) {

            // The SecureConnectionAgent relies secure messages destined to this agent through local events.
            // Since this messages arrive through a secured connection, we know the sender is in possesion of
            // a given identity, and we know at which identity the message was directed (encrypted for).

            let secMsgEv = ev as SecureMessageReceivedEvent;
            let payload: SecureMessage = secMsgEv.content.payload;

            if (payload.type === SecureMessageTypes.PeerMessage) {
                this.onPeerMessage(secMsgEv.content.connId, secMsgEv.content.sender, secMsgEv.content.recipient, payload.peerGroupId, payload.agentId, payload.content);
            } else if (payload.type === SecureMessageTypes.ChooseConnection || payload.type === SecureMessageTypes.ConfirmChosenConnection) {
                this.onConnectionSelection(secMsgEv.content.connId, secMsgEv.content.sender, secMsgEv.content.recipient, payload.type, payload.peerGroupId);
            }
        } else if (ev.type === NetworkEventType.MessageReceived) {
            let msgEv = ev as MessageReceivedEvent;
            this.receiveMessage(msgEv.content.connectionId , msgEv.content.source, msgEv.content.destination, msgEv.content.content);
        }
    }

    receiveMessage(connId: ConnectionId, source: Endpoint, destination: Endpoint, content: any): void {
        
        let message = content as PeerMeshAgentMessage;

        if (message.type === PeerMeshAgentMessageType.PeeringOffer) {
            let offer = (content as PeeringOfferMessage).content;

            this.onReceivingOffer(connId, source, destination, offer.peerGroupId, offer.localIdentityHash);
        } else if (message.type === PeerMeshAgentMessageType.PeeringOfferReply) {
            let offerReply = (content as PeeringOfferReplyMessage).content;

            this.onReceivingOfferReply(connId, source, destination, offerReply.peerGroupId, offerReply.localIdentityHash, offerReply.accepted);
        }

    }

    private checkConnectionRemoteInstance(connId: ConnectionId) {

        const connInfo = this.getNetworkAgent().getConnectionInfo(connId);

        if (connInfo !== undefined) {
            const chosenInstanceId = this.instanceIdPerEndpoint.get(connInfo.remoteEndpoint);

            const result = chosenInstanceId === undefined || chosenInstanceId === connInfo.remoteInstanceId;

            if (!result) {
                console.log('REASON: chosen=' + chosenInstanceId + ', remote=' + connInfo.remoteInstanceId);
            }

            return result;
        } else {
            console.log('REASON: connInfo is undefined');
            return false;
        }
    }

    private attemptToSetRemoteInstance(connId: ConnectionId) {
        const connInfo = this.getNetworkAgent().getConnectionInfo(connId);

        if (connInfo !== undefined) {

            const remote           = connInfo.remoteEndpoint
            const remoteInstanceId = connInfo.remoteInstanceId;

            if (remoteInstanceId !== undefined) {
                const chosenInstanceId = this.instanceIdPerEndpoint.get(remote);

                if (chosenInstanceId === undefined) {
                    this.instanceIdPerEndpoint.set(remote, remoteInstanceId);
                    PeerGroupAgent.controlLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint + ': setting remote instance for ' + remote + ' to ' + remoteInstanceId + ' because of connId ' + connId)
                    return true;
                } else {
                    return chosenInstanceId === remoteInstanceId;
                }
            } else {
                return true;
            }
        }
        

        return false;
    }

    // emitted events

    private broadcastNewPeerEvent(peer: PeerInfo) {
        
        PeerGroupAgent.controlLog.debug(this.peerGroupId + '/' + this.localPeer.endpoint + ': new peer: ' + peer.endpoint);

        if (this.firstPeer === undefined) {
            this.firstPeer = Date.now();
            PeerGroupAgent.controlLog.trace(this.peerGroupId + '/' + this.localPeer.endpoint + ': time to first peer: ' + (this.firstPeer - this.startup) + 'ms');
        }

        let ev: NewPeerEvent = {
            type: PeerMeshEventType.NewPeer,
            content: {
                peerGroupId: this.peerGroupId,
                peer: peer
            }
        };

        this.pod?.broadcastEvent(ev);
    }

    private broadcastLostPeerEvent(peer: PeerInfo) {
        PeerGroupAgent.controlLog.debug(this.peerGroupId + '/' + this.localPeer.endpoint + ': lost a peer: ' + peer.endpoint);

        let ev: LostPeerEvent = {
            type: PeerMeshEventType.LostPeer,
            content: {
                peerGroupId: this.peerGroupId,
                peer: peer
            }
        };

        this.pod?.broadcastEvent(ev);
    }

    // shorthand functions

    private getNetworkAgent() {
        return this.pod?.getAgent(NetworkAgent.AgentId) as NetworkAgent;
    }

    private getLocalAgent(agentId: AgentId) {
        return this.pod?.getAgent(agentId) as Agent;
    }

    private getSecureConnAgent() {
        return this.getLocalAgent(SecureNetworkAgent.Id) as SecureNetworkAgent;
    }

    static agentIdForPeerGroup(peerGroupId: string) {
        return 'peer-control-for-' + peerGroupId;
    }

}

type Config = Partial<Params>;
export { PeerGroupAgent, PeerInfo, PeerMeshEventType, NewPeerEvent, LostPeerEvent, Config as PeerGroupAgentConfig };