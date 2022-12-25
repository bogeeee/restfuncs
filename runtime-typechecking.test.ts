import 'reflect-metadata'
import {isTypeInfoAvailable, restfuncs, RestService} from "restfuncs-server";
import express from "express";
import {RestfuncsClient, restfuncsClient} from "restfuncs-client";
import {reflect} from "@typescript-rtti/reflect";

jest.setTimeout(60 * 60 * 1000); // Increase timeout to 1h to make debugging possible

async function runClientServerTests<Api extends object>(serverAPI: Api, clientTests: (proxy: Api) => void, path = "/api") {
    const app = express();
    app.use(path, restfuncs(serverAPI, {checkParameters: true}));
    const server = app.listen();
    // @ts-ignore
    const serverPort = server.address().port;

    const client = restfuncsClient<Api>(`http://localhost:${serverPort}${path}`);
    await clientTests(client);
    // shut down server
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
}

async function expectAsyncFunctionToThrow(f: (...any) => any, expected?: string | RegExp | Error | jest.Constructable) {
    let caught = null;
    try {
        const result = await f();
    }
    catch (e) {
        caught = e;
    }

    expect( () => {
        if(caught) {
            throw caught;
        }
    }).toThrow(expected);
}

test('Test if if rtti is available', async () => {
    class User {
        id : number;
        username? : string;
        protected favoriteColor? : number | string;
        doIt() { return 123; }
    }

    const reflectedClass = reflect(User);

    expect(reflectedClass.getProperty("xxx")).toBeUndefined(); // seeing this error means, we get a value for ANY nonexisting property. The compilation process does not work properly

    expect(reflectedClass
        .getProperty('favoriteColor')
        .type.is('union')).toBe(true);

    expect(isTypeInfoAvailable(new class {
    })).toBeTruthy();
});

test('Test parameters', async () => {
    class ServerAPI {
        myVoidMethod() {
        }
        params1(x: string) {
        }
        params2(x: string, y: number, z: {}) {
        }
    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            await apiProxy.myVoidMethod();
            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.myVoidMethod("illegalParam"), "Too many arguments");

            await apiProxy.params1("ok");

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.params1("ok", "illegal"), "Too many arguments");
        }
    );
})


test('Test visibility', async () => {
    class BaseServerAPI {
        protected myPublic(x: string) {
        }
    }

    class ServerAPI extends BaseServerAPI{
        myVoidMethod() {
        }

        public myPublic(x: string) {
        }

        protected myProtected(x: string) {

        }

        private myPrivate(x:string) {

        }

    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            await apiProxy.myVoidMethod();

            await apiProxy.myPublic("x");

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.myProtected("x"), "protected");


            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.myPrivate("x"), "private");

        }
    );
})

test('Test with anonymous class', async () => {

    await runClientServerTests(new class {
            params1(x: string) {
            }
        },
        async (apiProxy) => {
            await apiProxy.params1("ok");

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.params1("ok", "illegal"), "Too many arguments");
        }
    );
})

/*
// This one fails with current typescript-rtti. But that's not a showstopper.
test('Test anonymous object as service', async () => {
    await runClientServerTests({
            myVoidMethod() {
            },
            params1(x: string) {
            },
            params2(x: string, y: number, z: {}) {
            },
        },
        async (apiProxy) => {
            await apiProxy.params1("ok");

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.params1("ok", "illegal"), "Too many arguments");
        }
    );
})
*/