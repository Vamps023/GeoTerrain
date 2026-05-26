const electron = require('electron');
console.log('typeof electron:', typeof electron);
if (typeof electron === 'object') {
  console.log('app:', typeof electron.app);
} else {
  console.log('value:', electron);
}
