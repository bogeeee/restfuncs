// Tricky async stuff, that could crash or hang jest ist moved to an extra file here

import {ServerSession as ServerSession} from "restfuncs-server";
import {remote} from "restfuncs-server/ServerSession";
import {resetGlobalState, runClientServerTests} from "./lib";

jest.setTimeout(60 * 60 * 1000); // Increase timeout to 1h to make debugging possible


beforeEach(() => {
    resetGlobalState();
});;


describe("callbacks", () => {
    class ServerAPI extends ServerSession {
        @remote()
        callVoidCallback3Times(callback: ()=>void) {
            callback();
            callback();
            callback();
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

})