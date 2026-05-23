const { app } = require('electron');

app.whenReady().then(() => {
  console.log('Electron app ready! Version:', process.versions.electron);
  app.quit();
});
