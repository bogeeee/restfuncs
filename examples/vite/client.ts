import {restClient} from "@restfuncs/client"
import {GreeterService} from "./GreeterService.js" // Import to have types

const greeterService = restClient<GreeterService>("/greeterAPI")
document.getElementById("view")!.textContent = await greeterService.greet("Bob")