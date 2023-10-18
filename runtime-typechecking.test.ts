import 'reflect-metadata'
import {isTypeInfoAvailable, ServerSession as ServerSession} from "restfuncs-server/ServerSession";
import express from "express";
import {reflect} from "typescript-rtti";
import {extendPropsAndFunctions} from "restfuncs-server/Util";
import {ClientProxy, RestfuncsClient} from "restfuncs-client";

jest.setTimeout(60 * 60 * 1000); // Increase timeout to 1h to make debugging possible

class Service extends ServerSession {
}

async function runClientServerTests<S extends Service>(service: S, clientTests: (proxy: ClientProxy<S>) => void, path = "/api") {


    const serviceClass = service.clazz;
    serviceClass.options = {logErrors: false, exposeErrors: true, ...serviceClass.options}

    const app = express();
    app.use(path, serviceClass.createExpressHandler());
    const server = app.listen();
    // @ts-ignore
    const serverPort = server.address().port;

    try {
        const client = new RestfuncsClient<S>(`http://localhost:${serverPort}${path}`);
        await clientTests(client.proxy);
    }
    finally {
        // shut down server
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
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

test('Test arguments', async () => {
    class ServerAPI extends Service{
        myVoidMethod() {
        }
        params1(x: string) {
        }
        params2(x: string, y: number, z: {}) {
        }

        setObjWithValues(z: {prop1: boolean}) {
        }

    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            await apiProxy.myVoidMethod();
            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.myVoidMethod("illegalParam"), "Too many arguments");

            await apiProxy.params1("ok");

            // Too many arguments:
            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.params1("ok", "illegal"), "Too many arguments");

            // To few arguments:
            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.params1(), );

            // With objects:
            await apiProxy.params2("ok", 123, {});

            await apiProxy.setObjWithValues({prop1: true});

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.setObjWithValues({prop1: 123}) );

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.setObjWithValues({}) );
        }
    );
})

test('Test arguments - extra properties value', async () => {
    class ServerAPI extends Service{
        params2(x: string, y: number, z: {}) {
        }
    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {

            // Extra property: (we could argue that we want to get an error here, or erase the additional value at runtime - to enhance security)
            await apiProxy.params2("ok", 123, {someExtraProperty: true});
        }
    );
})

test('Test BigInt', async () => {

    class A {
        i: BigInt
    }

    const iProp = reflect(A).getProperty("i");
    expect(iProp.matchesValue(123n)).toBe(true);
    expect(iProp.matchesValue(undefined)).toBe(false);
    expect(iProp.matchesValue(null)).toBe(false);
    expect(iProp.matchesValue(123)).toBe(false);
    expect(iProp.matchesValue("")).toBe(false);
    expect(iProp.matchesValue(-1)).toBe(false);
    expect(iProp.matchesValue(Number.NaN)).toBe(false);
    expect(iProp.matchesValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(iProp.matchesValue(Number.NEGATIVE_INFINITY)).toBe(false);
})

/**
 * See https://github.com/typescript-rtti/typescript-rtti/issues/92
 */
test('Test additional properties / overstrict checks', async () => {
    class ServerAPI extends Service {
        setObjWithValues(z: {prop1: boolean}) {
        }

    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.setObjWithValues({prop1: true, poisonedProp: true}) );
        }
    );
})


test('Test rest arguments', async () => {
    class ServerAPI extends Service {
        restParams(x: string, ...y: number[]) {

        }
    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            await apiProxy.restParams("x");
            await apiProxy.restParams("x", 1,2,3);

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", 1,2,3, {}) );

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", 1,2,3, undefined) );

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", 1,undefined,3) );

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", []) );

            const variousInvalidRestParams = ["", null, undefined, true, false, "string", {}, {a:1, b:"str", c:null, d: {nested: true}}, [], [1,2,3], "null", "undefined", "0", "true", "false", "[]", "{}", "''"]
            for(let p of variousInvalidRestParams) {
                // @ts-ignore
                await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", p) );
            }

            // @ts-ignore
            await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", []) );

        }
    );
})

/*
// Not yet implemented
test('Test destructuring arguments', async () => {
    class ServerAPI {
        restParams(x: string, {a: boolean, b: string}) {

        }
    };

    await runClientServerTests(new ServerAPI(),
        async (apiProxy) => {
            await apiProxy.restParams("x", {a: true, b: "test"});

            const variousInvalidParams = ["", null, undefined, true, false, "string", {}, {a:1, b:"str", c:null, d: {nested: true}}, [], [1,2,3], "null", "undefined", "0", "true", "false", "[]", "{}", "''"]
            for(let p of variousInvalidParams) {
                // @ts-ignore
                await expectAsyncFunctionToThrow( async () => await apiProxy.restParams("x", p) );
            }

        }
    );

});
*/

test('Test visibility', async () => {
    class BaseServerAPI extends Service{
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

    await runClientServerTests(new class extends Service{
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