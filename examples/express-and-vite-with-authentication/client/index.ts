import {RestfuncsClient} from "restfuncs-client"
import type {MainframeSession} from "../MainframeSession.js" // Import to have types
import type {IServerSession} from "restfuncs-common";

interface WithLogin extends IServerSession {
    login(userName: string): Promise<boolean>;
}

/**
 * This example subclasses the RestfuncsClient so you have a reusable client class for all your services (if you have multiple).
 * You may write instead then: class RestfuncsClientWithLogin<S extends MyBaseService> ...
 */
class RestfuncsClientWithLogin<S extends WithLogin> extends RestfuncsClient<S> {
    async doCall(funcName: string, args: any[]) {
        try {
            return await super.doCall(funcName, args);
        }
        catch (e) {
            if(e?.cause?.name === "NotLoggedInError") {
                await this.doGuidedLogin();
                return await super.doCall(funcName, args); // We are so kind to finish the original call. Look how the result is immediately displayed after entering the correct username
            }

            throw e;
        }
    }

    /**
     * Shows a login dialog until the user is successfully logged in
     */
    async doGuidedLogin() {
        let loginSuccessfull
        do {
            const userName = prompt("To access our expensive mainframe computation service, you need to be logged in.\nPlease enter your name")
            loginSuccessfull = await this.proxy.login(userName);
        } while(!loginSuccessfull)
    }
}

const mainframeService = new RestfuncsClientWithLogin<MainframeSession>("/mainframeAPI").proxy // This is the way to use a subclassed RestfuncsClient

// Click handler for multiply button:
document.getElementById("multiplyButton")!.onclick = async function() {
    // @ts-ignore
    const inputValue = document.getElementById("numberInput").value
    const result = await mainframeService.multiplyBy10(Number(inputValue));
    document.getElementById("multiplyResult")!.textContent = "Result: " + String(result) // show result
}


