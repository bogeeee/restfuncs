// Tricky async stuff, that could crash or hang jest ist moved to an extra file here

import {
    ClientCallbackSet,
    ClientCallbackSetPerItem,
    ServerSession as ServerSession,
    ServerSessionOptions
} from "restfuncs-server";
import {remote} from "restfuncs-server";
import {free} from "restfuncs-server/ServerSession";
import {expectAsyncFunctionToThrow, resetGlobalState, runClientServerTests} from "./lib";
import {_testForRaceCondition_breakPoints} from "restfuncs-common";

jest.setTimeout(60 * 60 * 1000); // Increase timeout to 1h to make debugging possible


beforeEach(() => {
    resetGlobalState();
    _testForRaceCondition_breakPoints.cleanUp();
});;

afterEach(() => {
    _testForRaceCondition_breakPoints.cleanUp();
});;


describe("callbacks", () => {
    class ServerAPI extends ServerSession {
        @remote()
        callVoidCallback3Times(callback: ()=>void) {
            callback();
            callback();
            callback();
        }

        @remote()
        callVoidCallbackWithArgs(callback: (a: number, b: string)=>void) {
            callback(1, "2");
        }


    }

    test("Wait until simple void callback has been called 3 times", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        await new Promise<void>((resolve, reject) => {
            let counter = 0;
            function myCallback() {
                counter++
                if(counter === 3) {
                    resolve();
                }
            }


            (async () => {
                try {
                    await apiProxy.callVoidCallback3Times(myCallback);
                }
                catch (e) {
                    reject(e);
                }
            })()

        })
    }, {
        useSocket: true
    }));


    test("Wait until void callback with args has been called", () => runClientServerTests(new ServerAPI, async (apiProxy) => {
        await new Promise<void>((resolve, reject) => {
            let counter = 0;

            function myCallback(a: number, b: string) {
                try {
                    expect(a).toBe(1);
                    expect(b).toBe("2");
                    resolve();
                } catch (e) {
                    reject(e);
                }
            }


            (async () => {
                try {
                    await apiProxy.callVoidCallbackWithArgs(myCallback);
                } catch (e) {
                    reject(e);
                }
            })()

        })
    }, {
        useSocket: true
    }));

})


test("Race condition on client that callback-handle is cleaned up but still in use", async () => {
    class ServerAPI extends ServerSession {
        static options: ServerSessionOptions = {devDisableSecurity: false /* so Restfuncs will see that it does not await an answer for the void callbacks and we get a clear finish*/}

        @remote()
        myMethod(cb: () => void) {
            _testForRaceCondition_breakPoints.offer("tests/callback-handle-cleanup/ServerAPI/myMethod");
            cb();
            free(cb);
        }
    }

    await runClientServerTests(new ServerAPI, async (apiProxy) => {
        _testForRaceCondition_breakPoints.enabled = true;

        const myReusableCallback = () => {};

        apiProxy.myMethod(myReusableCallback);
        let break1 = await _testForRaceCondition_breakPoints.waitTilReached("client/ClientSocketConnection/handleMessage/channelItemNotUsedAnymore");
        const finished = apiProxy.myMethod(myReusableCallback);

        let break2 = await _testForRaceCondition_breakPoints.waitTilReached("tests/callback-handle-cleanup/ServerAPI/myMethod");
        break1.resume();
        break2.resume();

        await finished;

    }, {
        useSocket: true,
    });



})

test("Unawaited void callback should not lead to 'unhandledrejection' after client disconnect and crash the whole process in development", async () => {
    class ServerAPI extends ServerSession {
        static options: ServerSessionOptions = {devDisableSecurity: true}

        @remote()
        myMethod(cb: () => void) {
            cb();
        }
    }

    await runClientServerTests(new ServerAPI, async (apiProxy) => {
        await apiProxy.myMethod(() => {
            // don't throw an error here
        })
    }, {
        useSocket: true,
    });
});

// May be, this test can be moved to the normal tests, cause it is not so much tricky (just a little)
test("ClientCallbackSet", async () => {
    type NewsArticle = {title: string, text: string}
    const newsArticleListeners = new ClientCallbackSet<[newsArticle: NewsArticle]>({maxListenersPerClient: 2, freeOnClientImmediately: true /* enable this feature so that it is used, but there's no test for it*/}); // Create a global event registry/emitter for this event. [newsArticle: NewsArticle] = the listener function's arguments.
    class MyServerSession extends ServerSession{
        // Expose the .on and .off event registering methods to the client:
        @remote onNewsArticleCreated(listener: (newsArticle: NewsArticle) => void) {
            newsArticleListeners.add(listener);
        }
        @remote offNewsArticleCreated(listener: (newsArticle: NewsArticle) => void) {
            newsArticleListeners.remove(listener);
        }
        @remote dummy() {

        }
    }

    const callback1 = jest.fn().mockImplementation((article: NewsArticle) => {if(!article.title) {throw new Error("Invalid article")}});
    const callback2 = jest.fn().mockImplementation((article: NewsArticle) => {if(!article.title) {throw new Error("Invalid article")}});
    await runClientServerTests(new MyServerSession(), async (apiProxy) => {
        await apiProxy.onNewsArticleCreated(callback1);
        await apiProxy.onNewsArticleCreated(callback1); // Duplicate. Should be ignored
        await apiProxy.onNewsArticleCreated(callback2);
        newsArticleListeners.call({title: "Hello", text: "World"});
        await apiProxy.dummy(); // Await for a complete client->server->client roundtrip and therefore, in the meanwhile, the callbacks should be called by now
        expect(callback1).toBeCalledTimes(1);
        expect(callback2).toBeCalledTimes(1);

        // Should exhaust maxlisteners
        await expectAsyncFunctionToThrow(() => apiProxy.onNewsArticleCreated((a: any) => {}), /max listeners/i);

        await apiProxy.offNewsArticleCreated(callback1);
        expect(newsArticleListeners.size).toBe(1);
        newsArticleListeners.call({title: "Hello", text: "World"});
        await apiProxy.dummy(); // Await for a complete client->server->client roundtrip and therefore, in the meanwhile, the callbacks should be called by now
        expect(callback1).toBeCalledTimes(1);
        expect(callback2).toBeCalledTimes(2);

    }, {useSocket: true});

    expect(newsArticleListeners.size).toBe(0); // Now, after the disconnect, it should be cleared
})

// May be, this test can be moved to the normal tests, cause it is not so much tricky (just a little)
test("ClientCallbackSet callForSure", async () => {
    type NewsArticle = {title?: string, text: string}
    const newsArticleListeners = new ClientCallbackSet<[newsArticle: NewsArticle]>({removeOnDisconnect: false}); // Create a global event registry/emitter for this event. [newsArticle: NewsArticle] = the listener function's arguments.
    let debug_ref: any;
    class MyServerSession extends ServerSession{
        // Expose the .on and .off event registering methods to the client:
        @remote onNewsArticleCreated(listener: (newsArticle: NewsArticle) => Promise<void>) {
            debug_ref = listener;
            newsArticleListeners.add(listener);
        }
        @remote offNewsArticleCreated(listener: (newsArticle: NewsArticle) => Promise<void>) {
            newsArticleListeners.remove(listener);
        }
        @remote dummy() {

        }
    }

    let callback1Counter = 0; let callback2Counter = 0;
    const callback1 = (async (article: NewsArticle) => {callback1Counter++;  if(!article.title) {throw new Error("Invalid article")}});
    const callback2 = (async (article: NewsArticle) => {callback2Counter++; if(!article.title) {throw new Error("Invalid article")}});
    await runClientServerTests(new MyServerSession(), async (apiProxy) => {
        await apiProxy.onNewsArticleCreated(callback1);
        await apiProxy.onNewsArticleCreated(callback2);
        await newsArticleListeners.callForSure({title: "Hello", text: "World"});
        expect(callback1Counter).toBe(1);
        expect(callback2Counter).toBe(1);

        await expectAsyncFunctionToThrow(() => newsArticleListeners.callForSure({ title: undefined, text: "World" }), /Invalid article/);
    }, {useSocket: true});
    console.log(debug_ref);

    await expectAsyncFunctionToThrow(() => newsArticleListeners.callForSure({title: "ok", text: "World"}), /disconnect|Connection closed|socket closed/i); // now that the client silently disconnected, there should be an error
})


// May be, this test can be moved to the normal tests, cause it is not so much tricky (just a little)
test("ClientCallbackSetPerItem with string keys", async () => {
    type User = { name: string }
    const chatJoinListenersForRooms = new ClientCallbackSetPerItem<string, [user: User]>({maxListenersPerClient: 3, freeOnClientImmediately: true /* see above*/});
    // const chatLeaveCallbacksForRooms = ... // A separate one for each event type. Allows more precise type parameters.
    class MyServerSession extends ServerSession {
        // Expose the .on and .off event registering methods to the client:
        @remote onJoinChat(chatRoomName: string, listener: (joiningUser: User) => void) {
            chatJoinListenersForRooms.add(chatRoomName, listener);
        }

        @remote offJoinChat(chatRoomName: string, listener: (joiningUser: User) => void) {
            chatJoinListenersForRooms.delete(chatRoomName, listener);
        }

        @remote dummy() {

        }
    }

    const callback1 = jest.fn().mockImplementation((user: User) => {if(!user.name) {throw new Error("Invalid User")}});
    const callback2 = jest.fn().mockImplementation((user: User) => {if(!user.name) {throw new Error("Invalid User")}});
    const callbackRoom2 = jest.fn().mockImplementation((user: User) => {if(!user.name) {throw new Error("Invalid User")}});
    await runClientServerTests(new MyServerSession(), async (apiProxy) => {
        // test with still empty "members" field:
        chatJoinListenersForRooms.call("dummy", {name: "dummy"});
        //@ts-ignore access protected field
        expect(chatJoinListenersForRooms.members).toBeUndefined() // assert internal state

        await apiProxy.onJoinChat("room1", callback1);
        await apiProxy.onJoinChat("room1", callback1); // Duplicate, should be ignored
        await apiProxy.onJoinChat("room1", callback2);
        //await apiProxy.onJoinChat("room2", callback2); // This is prevented and results in an error
        await apiProxy.onJoinChat("room2", callbackRoom2);

        chatJoinListenersForRooms.call("room1", {name: "user"});
        await apiProxy.dummy(); // Await for a complete client->server->client roundtrip and therefore, in the meanwhile, the callbacks should be called by now
        expect(callback1).toBeCalledTimes(1);
        expect(callback2).toBeCalledTimes(1);
        expect(callbackRoom2).toBeCalledTimes(0);

        // Only callback2 should be called
        chatJoinListenersForRooms.call("room2", {name: "user"});
        await apiProxy.dummy(); // Await for a complete client->server->client roundtrip and therefore, in the meanwhile, the callbacks should be called by now
        expect(callback1).toBeCalledTimes(1);
        expect(callback2).toBeCalledTimes(1);
        expect(callbackRoom2).toBeCalledTimes(1);

        // Should exhaust maxlisteners
        await expectAsyncFunctionToThrow(() => apiProxy.onJoinChat("room1", (a: any) => {}), /max listeners/i);

        await apiProxy.offJoinChat("room1", callback1);
        chatJoinListenersForRooms.call("room1", {name: "user"});
        await apiProxy.dummy(); // Await for a complete client->server->client roundtrip and therefore, in the meanwhile, the callbacks should be called by now
        expect(callback1).toBeCalledTimes(1);
        expect(callback2).toBeCalledTimes(2);
        expect(callbackRoom2).toBeCalledTimes(1);

        await apiProxy.offJoinChat("room2", callbackRoom2);
        //@ts-ignore access protected field
        expect((chatJoinListenersForRooms.members?.size)).toBe(1); // assert internal state

        // Event for nonexisting room:
        chatJoinListenersForRooms.call("nonexisting", {name: "user"});
        await apiProxy.dummy(); // Await for a complete client->server->client roundtrip and therefore, in the meanwhile, the callbacks should be called by now
        expect(callback1).toBeCalledTimes(1); // should be the same as before
        expect(callback2).toBeCalledTimes(2); // should be the same as before
        expect(callbackRoom2).toBeCalledTimes(1); // should be the same as before

        // Test removeAllForItem:
        await apiProxy.onJoinChat("roomX", () => {});
        await apiProxy.onJoinChat("roomX", () => {});
        //@ts-ignore access protected field
        expect(chatJoinListenersForRooms.members?.has("roomX")).toBeTruthy(); // assert internal state
        chatJoinListenersForRooms.removeAllForItem("roomX");
        //@ts-ignore access protected field
        expect(chatJoinListenersForRooms.members?.has("roomX")).toBeFalsy(); // assert internal state

    }, {useSocket: true});

    //@ts-ignore access protected field
    expect((chatJoinListenersForRooms.members?.size)).toBe(0); // assert internal state. Now, after the disconnect, it should be cleared
})

// May be, this test can be moved to the normal tests, cause it is not so much tricky (just a little)
test("ClientCallbackSetPerItem with object keys", async () => {
    type KeyObj = object
    type User = { name: string }
    const chatJoinListenersForRooms = new ClientCallbackSetPerItem<KeyObj, [user: User]>({maxListenersPerClient: 3, freeOnClientImmediately: true /* see above*/});
    // const chatLeaveCallbacksForRooms = ... // A separate one for each event type. Allows more precise type parameters.
    const chatRoomObjects = {"room1": {}, "room2": {}}
    class MyServerSession extends ServerSession {
        // Expose the .on and .off event registering methods to the client:
        @remote onJoinChat(chatRoomName: string, listener: (joiningUser: User) => void) {
            chatJoinListenersForRooms.add(chatRoomObjects[chatRoomName], listener);
        }

        @remote offJoinChat(chatRoomName: string, listener: (joiningUser: User) => void) {
            chatJoinListenersForRooms.delete(chatRoomObjects[chatRoomName], listener);
        }

        @remote dummy() {

        }
    }

    const callback1 = jest.fn().mockImplementation((user: User) => {if(!user.name) {throw new Error("Invalid User")}});
    const callback2 = jest.fn().mockImplementation((user: User) => {if(!user.name) {throw new Error("Invalid User")}});
    const callbackRoom2 = jest.fn().mockImplementation((user: User) => {if(!user.name) {throw new Error("Invalid User")}});
    await runClientServerTests(new MyServerSession(), async (apiProxy) => {
        await apiProxy.onJoinChat("room1", callback1);
        await apiProxy.onJoinChat("room1", callback1); // Duplicate, should be ignored
        await apiProxy.onJoinChat("room1", callback2);
        //await apiProxy.onJoinChat("room2", callback2); // This is prevented and results in an error
        await apiProxy.onJoinChat("room2", callbackRoom2);

        chatJoinListenersForRooms.call(chatRoomObjects["room1"], {name: "user"});
        await apiProxy.dummy(); // Await for a complete client->server->client roundtrip and therefore, in the meanwhile, the callbacks should be called by now
        expect(callback1).toBeCalledTimes(1);
        expect(callback2).toBeCalledTimes(1);
        expect(callbackRoom2).toBeCalledTimes(0);

        // Only callback2 should be called
        chatJoinListenersForRooms.call(chatRoomObjects["room2"], {name: "user"});
        await apiProxy.dummy(); // Await for a complete client->server->client roundtrip and therefore, in the meanwhile, the callbacks should be called by now
        expect(callback1).toBeCalledTimes(1);
        expect(callback2).toBeCalledTimes(1);
        expect(callbackRoom2).toBeCalledTimes(1);

        // Should exhaust maxlisteners
        await expectAsyncFunctionToThrow(() => apiProxy.onJoinChat("room1", (a: any) => {}), /max listeners/i);

        await apiProxy.offJoinChat("room1", callback1);
        chatJoinListenersForRooms.call(chatRoomObjects["room1"], {name: "user"});
        await apiProxy.dummy(); // Await for a complete client->server->client roundtrip and therefore, in the meanwhile, the callbacks should be called by now
        expect(callback1).toBeCalledTimes(1);
        expect(callback2).toBeCalledTimes(2);
        expect(callbackRoom2).toBeCalledTimes(1);

        await apiProxy.offJoinChat("room2", callbackRoom2);
        //@ts-ignore access protected field
        expect((chatJoinListenersForRooms.members?.has(chatRoomObjects["room1"]))).toBeTruthy(); // assert internal state
        //@ts-ignore access protected field
        expect((chatJoinListenersForRooms.members?.has(chatRoomObjects["room2"]))).toBeFalsy(); // assert internal state

        // Event for nonexisting room:
        chatJoinListenersForRooms.call({}, {name: "user"});
        await apiProxy.dummy(); // Await for a complete client->server->client roundtrip and therefore, in the meanwhile, the callbacks should be called by now
        expect(callback1).toBeCalledTimes(1); // should be the same as before
        expect(callback2).toBeCalledTimes(2); // should be the same as before
        expect(callbackRoom2).toBeCalledTimes(1); // should be the same as before

        // Test removeAllForItem:
        await apiProxy.onJoinChat("room2", () => {});
        await apiProxy.onJoinChat("room2", () => {});
        //@ts-ignore access protected field
        expect((chatJoinListenersForRooms.members?.has(chatRoomObjects["room2"]))).toBeTruthy(); // assert internal state
        chatJoinListenersForRooms.removeAllForItem(chatRoomObjects["room2"]);
        //@ts-ignore access protected field
        expect((chatJoinListenersForRooms.members?.has(chatRoomObjects["room2"]))).toBeFalsy(); // assert internal state

    }, {useSocket: true});

    //@ts-ignore access protected field
    // assert internal state. Now, after the disconnect, `members` should be cleared
    //@ts-ignore access protected field
    expect((chatJoinListenersForRooms.members?.has(chatRoomObjects["room1"]))).toBeFalsy();
    //@ts-ignore access protected field
    expect((chatJoinListenersForRooms.members?.has(chatRoomObjects["room2"]))).toBeFalsy();

})

// May be, this test can be moved to the normal tests, cause it is not so much tricky (just a little)
test("ClientCallbackSetPerItem#callForSure with string keys", async () => {
    type User = { name?: string }
    const chatJoinListenersForRooms = new ClientCallbackSetPerItem<string, [user: User]>({removeOnDisconnect: false});
    // const chatLeaveCallbacksForRooms = ... // A separate one for each event type. Allows more precise type parameters.
    class MyServerSession extends ServerSession {
        // Expose the .on and .off event registering methods to the client:
        @remote onJoinChat(chatRoomName: string, listener: (joiningUser: User) => Promise<void>) {
            chatJoinListenersForRooms.add(chatRoomName, listener);
        }

        @remote offJoinChat(chatRoomName: string, listener: (joiningUser: User) => Promise<void>) {
            chatJoinListenersForRooms.delete(chatRoomName, listener);
        }

        @remote dummy() {

        }
    }


    let callback1Counter = 0; let callback2Counter = 0;
    const callback1 = (async (user: User) => {callback1Counter++;  if(!user.name) {throw new Error("Invalid user")}});
    const callback2 = (async (user: User) => {callback2Counter++;  if(!user.name) {throw new Error("Invalid user")}});
    await runClientServerTests(new MyServerSession(), async (apiProxy) => {
        await apiProxy.onJoinChat("room1",callback1);
        await apiProxy.onJoinChat("room1",callback2);
        await chatJoinListenersForRooms.callForSure("room1", {name: "Dummy"});
        expect(callback1Counter).toBe(1);
        expect(callback2Counter).toBe(1);

        await chatJoinListenersForRooms.callForSure("nonexisting room", {name: "Dummy"});
        expect(callback1Counter).toBe(1); // Should be the same as before
        expect(callback2Counter).toBe(1); // Should be the same as before

        await expectAsyncFunctionToThrow(() => chatJoinListenersForRooms.callForSure("room1", {name: undefined}), /Invalid user/);
    }, {useSocket: true});

    await expectAsyncFunctionToThrow(() => chatJoinListenersForRooms.callForSure("room1", {name: "Dummy"}), /disconnect|Connection closed|socket closed/i); // now that the client silently disconnected, there should be an error
})

test("It should not crash with exotic errors", async () => {
    class MyServerSession extends ServerSession{
        @remote throwExoticError() {
            let error = new Error("My error") as any;
            error.someFn = () => {}; // this is exotic and not serializeable
            throw error
        }
    }
    await runClientServerTests(new MyServerSession(), async (apiProxy) => {
        await expectAsyncFunctionToThrow(() => apiProxy.throwExoticError(), "My error");
        }, {}
    );
});

test("It should not crash when having a serialization error", async () => {
    class MyServerSession extends ServerSession{
        @remote remoteMethod() {
            return () => {}; // cannot serialize this
        }
    }
    await runClientServerTests(new MyServerSession(), async (apiProxy) => {
            await expectAsyncFunctionToThrow(() => apiProxy.remoteMethod(), "serialize");
        }, {}
    );
});

test("It should not crash when having a serialization error - with unserializable errors", async () => {
    class MyServerSession extends ServerSession{
        @remote remoteMethod() {
            const error = new Error("Non ser. error") as any;
            error.fn = () => {}
            error.recursive = error;
            throw error;
        }
    }
    await runClientServerTests(new MyServerSession(), async (apiProxy) => {
            await expectAsyncFunctionToThrow(() => apiProxy.remoteMethod(), /serializing|Converting circular structure to JSON/);
        }, {}
    );
});