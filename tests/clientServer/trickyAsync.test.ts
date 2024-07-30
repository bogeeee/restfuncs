// Tricky async stuff, that could crash or hang jest ist moved to an extra file here

import {ServerSession as ServerSession, ServerSessionOptions} from "restfuncs-server";
import {free, remote} from "restfuncs-server/ServerSession";
import {resetGlobalState, runClientServerTests} from "./lib";
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

describe("Error in an unawaited callback promise", () => {

    for(const disableSecurity of [false, true]) {
        test(`Throwing an Error in an unawaited callback promise should not lead to 'unhandledrejections' and crash the whole process - with disableSecurity=${disableSecurity}`, async () => {
            class ServerAPI extends ServerSession {
                static options: ServerSessionOptions = {devDisableSecurity: disableSecurity}

                @remote()
                myMethod(cb: () => Promise<void>) {
                    cb(); // not awaiting the result
                }
            }

            await runClientServerTests(new ServerAPI, async (apiProxy) => {
                await apiProxy.myMethod(async () => {
                    throw new Error("This error should not lead to an 'unhandledrejection' and crash the whole process");
                })
            }, {
                useSocket: true,
            });
        });
    }
});