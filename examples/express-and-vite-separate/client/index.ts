import {restfuncsClient} from "restfuncs-client"
import {GreeterService} from "../server/GreeterService.js"; // Import to have types

(async () => {
    const greeterService = restfuncsClient<GreeterService>("/greeterAPI")
    document.getElementById("main")!.textContent = await greeterService.greet("Bob")
})()