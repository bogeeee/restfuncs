export class GreeterService{

    async greet(name: string) {
        return `Hello ${name} from the server`
    }

    // ... more functions go here
}