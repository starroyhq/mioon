// Loaded by electron-builder only for the explicit signed release invocation.
const path = require('node:path');
const {pathToFileURL} = require('node:url');
module.exports = async function afterSign(context) {
  const {notarizeApp} = await import(pathToFileURL(path.join(__dirname, 'apple-notarization.ts')).href);
  await notarizeApp(context);
};
