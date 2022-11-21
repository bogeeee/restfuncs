import {RestClient, restClient} from "@restfuncs/client"
import {MainframeService} from "./MainframeService.js" // Import to have types

class RestClientWithLogin extends RestClient<MainframeService> {
    async doCall(funcName: string, args: any[]) {
        try {
            return await super.doCall(funcName, args);
        }
        catch (e) {
            if(e?.cause?.name === "NotLoggedInError") {
                this.doGuidedLogin();
            }
            else {
                throw e;
            }
        }
    }

    /**
     * Shows a login dialog until the user is successfully logged in
     */
    async doGuidedLogin() {
        let loginSuccessfull
        do {
            const userName = prompt("To access our expensive mainframe computation service, you need to be logged in.\nPlease enter your name")
            loginSuccessfull = await this.login(userName);
        } while(!loginSuccessfull)
    }
}

const mainframeService = new RestClientWithLogin("/greeterAPI").proxy

document.getElementById("multiplyButton").onclick = async function() {
    // @ts-ignore
    const inputValue = document.getElementById("numberInput").value
    const result = await mainframeService.multiplyBy10(Number(inputValue));
    document.getElementById("multiplyResult").textContent = "Result: " + String(result) // show result
}


