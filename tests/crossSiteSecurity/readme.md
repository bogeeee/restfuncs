# Cross site security test cases 
Tests for CSRF scenarios in the browser.

### Run it
```bash
git clone https://github.com/bogeeee/restfuncs.git
cd restfuncs/tests/crossSiteSecurity
npm install --ignore-scripts
npn run dev
```

Now open http://localhost:3000 and http://localhost:3666 in the browser and 
for both, check the status (main/cross site + if tests succeeded).

### Development

See clientTests.ts/runAlltests function