import {restfuncs, RestService} from "restfuncs-server";
import 'reflect-metadata'
import express from "express";
import {RestfuncsClient, restfuncsClient} from "restfuncs-client";
import {reflect} from "@typescript-rtti/reflect";

jest.setTimeout(60 * 60 * 1000); // Increase timeout to 1h to make debugging possible

async function runClientServerTests<Api extends object>(serverAPI: Api, clientTests: (proxy: Api) => void, path = "/api") {
    const app = express();
    app.use(path, restfuncs(serverAPI));
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
});
