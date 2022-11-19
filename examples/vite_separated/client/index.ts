import {restClient} from "@restfuncs/client"
import {GreeterService} from "../server/GreeterService.js"; // Import to have types

(async () => {
    const greeterService = restClient<GreeterService>("/greeterAPI")
    document.getElementById("main")!.textContent = await greeterService.greet("Bob")
})()