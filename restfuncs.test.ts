import {createRESTFuncsHandler} from "@restfuncs/server";
import express from "express";
import {createRESTFuncsClient} from "@restfuncs/client";

let serverPort = 10000; // this is increased
jest.setTimeout(60 * 60 * 1000); // Increase timeout to 1h to make debugging possible

async function runClientServerTests<Api extends object>(serverAPI: Api, clientTests: (proxy: Api) => void, path = "/api") {
    const app = express();
    app.use(path, createRESTFuncsHandler(serverAPI));
    serverPort++; // Bugfix: axios client throws a "socket hung up" when reusing the same port
    const server = app.listen(serverPort);
    // @ts-ignore
    const client = createRESTFuncsClient<Api>(`http://localhost:${serverPort}${path}`);
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
            expect(await apiProxy.myMethod("hello1", "hello2")).toBe("OK");
        }
    );
});

test('test with different api paths', async () => {
    for(let path of ["","/", "/api/","/sub/api"]) {
        await runClientServerTests({
                myMethod(arg1, arg2) {
                    expect(arg1).toBe("hello1");
                    expect(arg2).toBe("hello2");
                    return "OK";
                }
            },
            async (apiProxy) => {
                expect(await apiProxy.myMethod("hello1", "hello2")).toBe("OK");
            }
            ,path
        );
    }
});

const variousDifferentTypes = ["", null, undefined, true, false, 49, 0, "string", {}, {a:1, b:"str", c:null, d: {nested: true}}, [], [1,2,3], "null", "undefined", "0", "true", "false", "[]", "{}", "''"];

test('Return types', async () => {
    for(let returnValue of variousDifferentTypes) {
        await runClientServerTests({
                myMethod() {
                    return returnValue;
                },

                myAsyncMethod() {
                    return new Promise((resolve) => resolve(returnValue)); // Make sure this uses promises
                }
            },
            async (apiProxy) => {
                if(returnValue === undefined) {
                    returnValue = null;
                }
                expect(await apiProxy.myMethod()).toStrictEqual(returnValue);
                expect(await apiProxy.myAsyncMethod()).toStrictEqual(returnValue);
            }
        );
    }
});


test('Parameter types', async () => {
    for(let param of variousDifferentTypes) {
        await runClientServerTests({
                myMethod(a,b,c) {
                    expect(a).toStrictEqual(param !== undefined?param:null);
                    expect(b).toBeFalsy();
                    expect(c).toStrictEqual(param !== undefined?param:null);
                },
            },
            async (apiProxy) => {
                await apiProxy.myMethod(param, undefined, param);
            }
        );
    }
});