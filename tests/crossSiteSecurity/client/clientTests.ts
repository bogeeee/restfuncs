import {RestfuncsClient} from "restfuncs-client"
import {TestsService} from "../TestsService";
import {MainframeService} from "../MainframeService";
import {ControlService} from "../ControlService";

export const mainSiteUrl = "http://localhost:3000";
export const isMainSite = window.location.href.startsWith(mainSiteUrl);
let failed = false;
const debug_failAllTestsOnFirstFail = false; // enable to have a better error stack trace in the console (use firefox instead of chrome then)

async function assertRuns(fn: () => Promise<void>) {
    await fn();
}

async function assertFails(fn: () => Promise<void>) {
    try {
        await fn();
        throw new Error("Expected to fail");
    }
    catch (e) {
        // ok
    }
}


function failTests(e: unknown) {
    failed = true;
    if(e) {
        if (debug_failAllTestsOnFirstFail) {
            throw e;
        }
        console.error(e);
    }
}

/**
 * Assert that it should fail same-site and also cross site
 *
 * function will report one failed test instead of throwing an Error
 * @param description
 * @param fn
 */
async function testAssertFailsSSAndXS(description: string, fn:() => Promise<void>) {
    console.log(description + "...");
    try {
        await assertFails(fn);
        console.log(`...expectedly fails`)
    }
    catch (e) {
        console.log(`...!!! runs but was expected to fail`)
        failTests(null);
    }

}

/**
 * Assert that it should work same-site and also cross site
 * function will report one failed test instead of throwing an Error
 * @param description
 * @param fn
 */
async function testAssertWorksSSAndXS(description: string, fn: () => Promise<void>) {
    console.log(description + "...");
    try {
        await assertRuns(fn);
        console.log(`...expectedly runs ${isMainSite?"": "cross site "}`)
    }
    catch (e) {
        console.log(`...!!! unexpectedly failed ${isMainSite?"": "cross site"}. See the following error:`)
        failTests(e)
    }

}

/**
 * Assert that it should work same-site but fail cross-site
 *
 * function will report one failed test instead of throwing an Error
 * @param description
 * @param fn
 */
async function testAssertWorksSSAndFailsXS(description: string, fn:() => Promise<void>) {
    console.log(description + "...");
    if(isMainSite) {
        try {
            await assertRuns(fn);
            console.log(`...expectedly runs on main site`)
        }
        catch (e) {
            console.log(`...!!! failed on main site. See the following error:`)
            failTests(e);
        }
    }
    else {
        try {
            await assertFails(fn);
            console.log(`...expectedly fails cross site`)
        }
        catch (e) {
            console.log(`...!!! runs cross site but was expected to fail`)
            failTests(null);
        }
    }

}

function assertEquals<T>(actual: T, expected: T) {
    if(actual !== expected) {
        throw new Error(`Assertion failed: actual: ${actual}, expected: ${expected}`);
    }
}

function makeSimpleXhrRequest(method: string, url: string, body = ""): Promise<string> {


    return new Promise((resolve, reject)=> {
        try {
            const xhr = new XMLHttpRequest();
            xhr.open(method, url, true);
            xhr.setRequestHeader("Content-Type", "text/plain");
            xhr.withCredentials = true;
            xhr.onreadystatechange = function (this: XMLHttpRequest, ev: Event) {
                if (this.readyState == 4) {
                    if(this.status === 200) {
                        resolve("")
                    }
                    else {
                        reject(this.responseText)
                    }
                }
            };
            xhr.send(body);
        }
        catch (e) {
            reject(e);
        }
    })



}

const controlService = new RestfuncsClient<ControlService>(`${mainSiteUrl}/controlService`, {useSocket: false}).proxy

async function createRestfuncsClient(serviceName: string, csrfProtectionMode: string) {
    // @ts-ignore
    const result = new RestfuncsClient<TestsService>(`${mainSiteUrl}/${serviceName}`, {csrfProtectionMode});
    if(csrfProtectionMode === "csrfToken") {
        // Fetch the token first:
        result.csrfToken = await controlService.getCsrfTokenForService(serviceName)
    }
    return result;
}

/**
 * Test CORS and simple requests. All with "preflight" security:
 */
async function testSuite_CORSAndSimpleRequests() {
    {
        await controlService.resetSession();

        const service = new RestfuncsClient<TestsService>(`${mainSiteUrl}/TestsService`, {csrfProtectionMode: "preflight"}).proxy
        const corsAllowedService = new RestfuncsClient<TestsService>(`${mainSiteUrl}/AllowedTestsService`, {csrfProtectionMode: "preflight"}).proxy

        /**
         * tests if runner successfully was able to spend money on bob's cookie-logged-in session.
         * @param runner
         */
        async function checkIfSpendsMoney(runner: () => Promise<void>) {
            await corsAllowedService.logon("bob"); // Logs in and give me some money
            assertEquals(await corsAllowedService.getBalance("bob"), 5000)
            let caught: any;
            try {
                await runner()
            } catch (e) {
                caught = e;
            }
            if (await corsAllowedService.getBalance("bob") !== 0) {
                throw new Error(`Money was not spent: ${caught?.message || caught || ""}`, {cause: caught});
            }
        }

        await testAssertWorksSSAndFailsXS("call test() on restricted service", async () => {
            assertEquals(await service.test(), "ok")
        });

        await testAssertWorksSSAndXS("call test() on allowed service", async () => {
            assertEquals(await corsAllowedService.test(), "ok")
        });

        // Simple requests:
        for (const method of ["GET", "POST"]) {
            await testAssertFailsSSAndXS(`Simple request on unsafe method (${method})`, async () => checkIfSpendsMoney(async () => {
                await makeSimpleXhrRequest(method, `${mainSiteUrl}/TestsService/unsafeMethod`)
            }));

            await testAssertWorksSSAndXS(`Simple request on safe method (${method})`, async () => checkIfSpendsMoney(async () => {
                await makeSimpleXhrRequest(method, `${mainSiteUrl}/AllowedTestsService/spendMoneyAccidentlyMarkedAsSafe`)
            }));
        }


        await testAssertWorksSSAndFailsXS("Spend money on restricted service", async () => checkIfSpendsMoney(async () => {
            await service.spendMoney();
        }));

        await testAssertWorksSSAndXS("Spend money on allowed service", async () => checkIfSpendsMoney(async () => {
            await corsAllowedService.spendMoney();
        }));


        // Test if we can spend money throug simple request (if they might get called but result can't be read)
        for (const method of ["GET", "POST"]) {
            // Test/Playground to see if makeSimpleXhrRequest really does make simple requests and if it's property detected. No real security indication
            await testAssertWorksSSAndFailsXS(`Simple request (${method})`, async () => {
                await makeSimpleXhrRequest(method, `${mainSiteUrl}/TestsService/getIsSimpleRequest`)
                assertEquals(await corsAllowedService.getLastCallWasSimpleRequest(), true);
            });
            await testAssertWorksSSAndXS(`Simple request (${method})`, async () => {
                await makeSimpleXhrRequest(method, `${mainSiteUrl}/AllowedTestsService/getIsSimpleRequest`, "xyz")
                assertEquals(await corsAllowedService.getLastCallWasSimpleRequest(), true);
            });

            //
            await testAssertWorksSSAndFailsXS(`Spend money on restricted service with simple request (${method})`, async () => checkIfSpendsMoney(async () => {
                await makeSimpleXhrRequest(method, `${mainSiteUrl}/TestsService/spendMoney`)
            }));

            await testAssertWorksSSAndXS(`Spend money on allowed service with simple request (${method})`, async () => checkIfSpendsMoney(async () => {
                await makeSimpleXhrRequest(method, `${mainSiteUrl}/AllowedTestsService/spendMoney`)
            }));
        }
    }
}

/**
 * Copying corsReadToken from an allowed service to a restricted service, ...
 */
async function testSuite_copyCorsReadToken() {
    if (isMainSite) {
        // isMainSite: AllowedTestsService_eraseOrigin doesn't work cross origin. We would need to mock it somehow that in the normal response the access-control-allow-origin header is filled with i.e localhost:3666.
        // Sencondly: The TestsService is blocked by browser's CORS anyway

        await testAssertWorksSSAndXS(`Copying corsReadToken from an allowed service to a restricted service should not work. Copying the proper one to the resrticted service should work`, async () => {
            await controlService.resetSession();

            // @ts-ignore
            const allowedClient = new RestfuncsClient<TestsService>(`${mainSiteUrl}/AllowedTestsService_eraseOrigin`, {csrfProtectionMode: "corsReadToken"});
            const allowedService = allowedClient.proxy
            await allowedService.logon("bob");

            const restrictedClient = new RestfuncsClient<TestsService>(`${mainSiteUrl}/TestsService`, {csrfProtectionMode: "corsReadToken"});
            const restrictedService = restrictedClient.proxy;
            const loginOnRestrictedService = async () => {
                await restrictedService.logon("bob");
            }

            if (isMainSite) {
                await loginOnRestrictedService();
            } else {
                await assertFails(loginOnRestrictedService)
            }

            // @ts-ignore
            if (!allowedClient._corsReadToken) {
                throw new Error("_corsReadToken was not yet fetched")
            }

            // Copy the one from allowed service:
            // @ts-ignore
            restrictedClient._corsReadToken = allowedClient._corsReadToken

            // Should still fail:
            if (isMainSite) {
                await loginOnRestrictedService();
            } else {
                await assertFails(loginOnRestrictedService)
            }

            // Obtain a valid one by cheating:
            // @ts-ignore
            restrictedClient._corsReadToken = await controlService.getCorsReadTokenForService("TestsService")
            await loginOnRestrictedService(); // now this should work
            assertEquals(await restrictedService.getBalance("bob"), 5000);
        });
    }
}

async function testSuite_csrfToken() {
    // CSRFToken:
    for (const serviceName of ["TestsService", "AllowedTestsService"]) {
        if (serviceName === "TestsService" && !isMainSite) {
            continue; // TestsService is blocked anyway by browser's CORS
        }
        await testAssertWorksSSAndXS(`Check if no/wrong csrfToken is rejected and proper token is accepted for ${serviceName}`, async () => {
            await controlService.resetSession();
            // @ts-ignore
            const client = new RestfuncsClient<TestsService>(`${mainSiteUrl}/${serviceName}`, {csrfProtectionMode: "csrfToken"});
            const service = client.proxy
            // no token:
            await assertFails(async () => {
                await service.logon("bob")
            })
            // wrong token:
            client.csrfToken = "wrongValue"
            await assertFails(async () => {
                await service.logon("bob")
            })

            // right token:
            client.csrfToken = await controlService.getCsrfTokenForService(serviceName);
            await service.logon("bob");
            assertEquals(await service.getBalance("bob"), 5000);

            // right token but from wrong service:
            client.csrfToken = await controlService.getCsrfTokenForService("MainframeService");
            await assertFails(async () => {
                await service.logon("bob")
            });
        });
    }
}

async function testSuite_csrfProtectionModesCollision() {
    // Test the "collision" of different csrfProtection modes:
    {
        for (const mode1 of ["preflight", "corsReadToken", "csrfToken"]) {
            for (const mode2 of ["preflight", "corsReadToken", "csrfToken"]) {
                if (mode1 == mode2) {
                    await testAssertWorksSSAndXS(`Requests from same session protection modes with forceTokenCheck, (${mode1} )`, async () => {
                        await controlService.resetSession();

                        for (const mode of [mode1, mode2]) {
                            const corsAllowedService = (await createRestfuncsClient("AllowedForceTokenCheckService", mode)).proxy
                            await corsAllowedService.test();
                        }
                    });
                    await testAssertWorksSSAndXS(`Requests from same session protection modes with session access, (${mode1} )`, async () => {
                        await controlService.resetSession();


                        const corsAllowedService1 = (await createRestfuncsClient("AllowedTestsService", mode1)).proxy
                        await corsAllowedService1.logon("bob");

                        const corsAllowedService2 = (await createRestfuncsClient("AllowedTestsService", mode2)).proxy
                        assertEquals(await corsAllowedService2.getBalance("bob"), 5000);
                    });

                } else {
                    for (const method of ["GET", "POST"]) {
                        await testAssertWorksSSAndXS(`Requests from different session protection modes but without session access, (simple ${method} ${mode1} vs restfuncs-client ${mode2} )`, async () => {
                            await controlService.resetSession();

                            await makeSimpleXhrRequest(method, `${mainSiteUrl}/AllowedTestsService/test?csrfProtectionMode=${mode1}`)

                            const corsAllowedService = (await createRestfuncsClient("AllowedTestsService", mode2)).proxy
                            await corsAllowedService.test();

                            await makeSimpleXhrRequest(method, `${mainSiteUrl}/AllowedTestsService/test`) // unspecified
                        });
                    }


                    await testAssertWorksSSAndXS(`Requests from different session protection modes with forceTokenCheck, (${mode1} vs ${mode2} )`, async () => {
                        await controlService.resetSession();

                        {
                            const corsAllowedService = (await createRestfuncsClient("AllowedForceTokenCheckService", mode1)).proxy
                            await corsAllowedService.test();
                        }
                        {
                            await assertFails(async () => {
                                const corsAllowedService = (await createRestfuncsClient("AllowedForceTokenCheckService", mode2)).proxy
                                await corsAllowedService.test();
                            })
                        }

                    });

                    await testAssertWorksSSAndXS(`Requests from different session protection modes with session access, (${mode1} vs ${mode2} )`, async () => {
                        await controlService.resetSession();


                        const service1 = (await createRestfuncsClient("AllowedTestsService", mode1)).proxy
                        await service1.logon("bob");

                        await assertFails(async () => {
                            const service2 = (await createRestfuncsClient("AllowedTestsService", mode2)).proxy
                            await service2.getBalance("bob")
                        });
                    });


                }

            }
        }

        // Test that undefined initializes the session as preflight
        await testAssertWorksSSAndXS(`Requests from different session protection modes with session access, (undefined = preflight vs corsReadToken )`, async () => {
            await controlService.resetSession();

            // @ts-ignore
            const corsAllowedService1 = new RestfuncsClient<TestsService>(`${mainSiteUrl}/AllowedTestsService`, {csrfProtectionMode: undefined}).proxy
            await corsAllowedService1.logon("bob");

            // @ts-ignore
            const corsAllowedService2 = new RestfuncsClient<TestsService>(`${mainSiteUrl}/AllowedTestsService`, {csrfProtectionMode: "corsReadToken"}).proxy
            await assertFails(async () => {
                await corsAllowedService2.getBalance("bob")
            });
        });

    }
}

export async function runAlltests() {
    failed = false;

    if(!isMainSite) {
        // cheap prevention of race condition if both browser windows reload at the same time:
        await new Promise(resolve => setTimeout(resolve, 4000)); // Wait a bit
    }


    await testSuite_CORSAndSimpleRequests();

    await testSuite_copyCorsReadToken();

    await testSuite_csrfToken();

    await testSuite_csrfProtectionModesCollision();

    return !failed;
}