
import { describeProxy } from '../config';
import { ChatRoom } from 'chat/model/ChatRoom';
import { Identity } from 'data/identity'
import { RSAKeyPair } from 'data/identity';
import { Store} from 'storage/store';
import { IdbBackend } from 'storage/backends';
import { RNGImpl } from 'crypto/random';
import { Mesh } from 'mesh/service';
import { Space } from 'spaces/Space';
import { Resources } from 'data/model';
import { IdentityPeer } from 'mesh/agents/peer';

describeProxy('[CHT] Chat example', () => {
    test( '[CHT01] Basic chat', async (done) => {

        let store1 = new Store(new IdbBackend(new RNGImpl().randomHexString(64)));
        let store2 = new Store(new IdbBackend(new RNGImpl().randomHexString(64)));

        let key1 = RSAKeyPair.generate(512);
        let key2 = RSAKeyPair.generate(512);

        await store1.save(key1);
        await store2.save(key2);

        let id1 = Identity.fromKeyPair({name: 'id1'}, key1);
        let id2 = Identity.fromKeyPair({name: 'id2'}, key2);

        await store1.save(id1);
        await store2.save(id2);

        let chatRoom1 = new ChatRoom('test chat room');
        let chatRoom2 = chatRoom1.clone();

        await store1.save(chatRoom1);
        await store2.save(chatRoom2);

        let mesh1 = new Mesh();
        let mesh2 = new Mesh();

        chatRoom1.setResources({store: store1, mesh: mesh1, config: {id: id1}, aliasing: new Map()});
        chatRoom1.startSync();

        chatRoom2.setResources({store: store2, mesh: mesh2, config: {id: id2}, aliasing: new Map()});
        chatRoom2.startSync();

        chatRoom1.join(id1);
        chatRoom2.join(id2);

        chatRoom1.say(id1, 'hello from id1');
        chatRoom2.say(id2, 'hello from id2');

        let checks = 0;

        while (chatRoom1.getMessages().size() < 2) {
            await new Promise(r => setTimeout(r, 100));
            if (checks>400) {
                break;
            }
            checks++;
        }

        expect(chatRoom1.getMessages().size()).toEqual(2);

        done();
    }, 50000);

    test( '[CHT02] Chat room discovery', async (done) => {

        let store1 = new Store(new IdbBackend(new RNGImpl().randomHexString(64)));
        let store2 = new Store(new IdbBackend(new RNGImpl().randomHexString(64)));

        let key1 = RSAKeyPair.generate(512);
        let key2 = RSAKeyPair.generate(512);

        await store1.save(key1);
        await store2.save(key2);

        let id1 = Identity.fromKeyPair({name: 'id1'}, key1);
        let id2 = Identity.fromKeyPair({name: 'id2'}, key2);

        await store1.save(id1);
        await store2.save(id2);

        let chatRoom1 = new ChatRoom('test chat room');

        await store1.save(chatRoom1);

        let mesh1 = new Mesh();
        let mesh2 = new Mesh();

        chatRoom1.setResources({store: store1, mesh: mesh1, config: {id: id1}, aliasing: new Map()});
        
        let space1 = Space.fromEntryPoint(chatRoom1, chatRoom1.getResources() as Resources, (await IdentityPeer.fromIdentity(id1).asPeer()).endpoint)
        space1.startBroadcast();
        
        let wordCode = await space1.getWordCoding();
        

        //console.log(wordCode.join(' '));

        let space2 = Space.fromWordCode(
            wordCode, 
            {store: store2, mesh: mesh2, config: {id: id2}, aliasing: new Map()},
            (await IdentityPeer.fromIdentity(id2).asPeer()).endpoint);

        //console.log('receiver is ' + (await IdentityPeer.fromIdentity(id2).asPeer()).endpoint);

        //console.log('awaiting object broadcast')
        let chatRoom2 = await space2.getEntryPoint() as ChatRoom;
        //console.log('got object');

        await store2.save(chatRoom2);


        chatRoom1.startSync();

        chatRoom2.setResources({store: store2, mesh: mesh2, config: {id: id2}, aliasing: new Map()});
        chatRoom2.startSync();
        
        chatRoom1.join(id1);
        chatRoom2.join(id2);

        chatRoom1.say(id1, 'hello from id1');
        chatRoom2.say(id2, 'hello from id2');

        let checks = 0;

        while (chatRoom1.getMessages().size() < 2) {
            await new Promise(r => setTimeout(r, 100));
            if (checks>600) {
                break;
            }
            checks++;
        }

        expect(chatRoom1.getMessages().size()).toEqual(2);
        done();
    }, 50000);


});