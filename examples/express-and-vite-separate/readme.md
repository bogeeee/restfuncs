Simple hello world example with express server and vite as packager.
Client(=web) and server are in separate packages / folders. The starter script entries are all under [server](server).

### Run it
```bash
git clone https://github.com/bogeeee/restfuncs.git
cd restfuncs/examples/express-and-vite-separate/server
npm install
npm run build
npm run start
```


### Development
```bash
npn run dev
```

Or `npn run dev:faster_but_without_rtti` which reloads faster and should still be good enough for your usual development needs.

_The dev script might look a bit strange but these are the best routes through the CommonJS/ESM/typescript/compilation/transformer/with_proper_debugging  jungle ;)_