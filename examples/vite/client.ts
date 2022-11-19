import {restClient} from "@restfuncs/client"
import {GreeterService} from "./GreeterService.js" // Import to have types

(async () => {
    const greeterService = restClient<GreeterService>("/greeterAPI")
    document.getElementById("main")!.textContent = await greeterService.greet("Bob")
})()
