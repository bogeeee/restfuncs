import {createRemoteServiceRouter} from "@restfuncs/server";
import express from "express";
import {RemoteServiceClient} from "@restfuncs/client";

let serverPort = 10000; // this is increased
jest.setTimeout(60 * 60 * 1000); // Increase timeout to 1h to make debugging possible

async function runClientServerTests<Api extends object>(serverAPI: Api, clientTests: (proxy: Api) => void, path = "/api") {
    const app = express();
    app.use(path, createRemoteServiceRouter(serverAPI));
    serverPort++; // Bugfix: axios client throws a "socket hung up" when reusing the same port
    const server = app.listen(serverPort);
    // @ts-ignore
    const client: Api = new RemoteServiceClient({url: `http://localhost:${serverPort}${path}`});
    await clientTests(client);
    // shut down server
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
}

test('Simply call a Void method', async () => {
    await runClientServerTests({
            myVoidMethod() {
            }
        },
        async (apiProxy) => {
            expect(await apiProxy.myVoidMethod()).toBeNull();
        }
    );
});

test('Simple api call', async () => {
    await runClientServerTests({
            myMethod(arg1, arg2) {
                expect(arg1).toBe("hello1");
                expect(arg2).toBe("hello2");
                return "OK";
            }
        },
        async (apiProxy) => {
            const i = 0;
            expect(await apiProxy.myMethod("hello1", "hello2")).toBe("OK");
        }
    );

});

test('test with diffrent api paths', async () => {
    for(let path of ["","/", "/api/","/sub/api"]) {
        await runClientServerTests({
                myMethod(arg1, arg2) {
                    expect(arg1).toBe("hello1");
                    expect(arg2).toBe("hello2");
                    return "OK";
                }
            },
            async (apiProxy) => {
                const i = 0;
                expect(await apiProxy.myMethod("hello1", "hello2")).toBe("OK");
            }
            ,path
        );
    }
});

const variousDiffrentTypes = ["", null, undefined, true, false, "null", "undefined", "0", "true", "false", 49, 0, "string", {}, {a:1, b:"str", c:null, d: {nested: true}}];

test('Return types', async () => {
    for(let returnValue of variousDiffrentTypes) {
        await runClientServerTests({
                myMethod() {
                    return returnValue;
                }
            },
            async (apiProxy) => {
                if(returnValue === undefined) {
                    returnValue = null;
                }
                expect(await apiProxy.myMethod()).toStrictEqual(returnValue);
            }
        );
    }
});