# Vicinae Extension

Congratulations on generating your new Vicinae extension!

You can install the required dependencies and run your extension in development mode like so:

```bash
npm install
npm run dev
```
If you want to build the production bundle, simply run:

```bash
npm run build
```



NOTE: to make it so that zen gets focused when opening a bookmark you need to add a window rule in the kde settings 
settings -> window rules -> add rule
Click Detect Window Properties and then select zen to get the window class for it after that add 2 Properties
Focus stealing preventions  set it to Force none
Accept focus set it to Force Yes
