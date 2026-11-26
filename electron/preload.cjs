'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', Object.freeze({
  isDesktop: true,
  serviceRequest(request) {
    return ipcRenderer.invoke('desktop:serviceRequest', request);
  },
  setAccountSession(token) {
    return ipcRenderer.invoke('desktop:setAccountSession', token);
  },
  getAccountSession() {
    return ipcRenderer.invoke('desktop:getAccountSession');
  },
  openAccountLogin(url) {
    return ipcRenderer.invoke('desktop:openAccountLogin', url);
  },
  setInteractiveRegions(rects) {
    ipcRenderer.send('desktop:regions', rects);
  },
  setMouseCapture(captured) {
    ipcRenderer.send('desktop:capture', captured);
  },
  setSceneMode(enabled) {
    ipcRenderer.send('desktop:scene-mode', enabled);
  },
  requestSurfaces() {
    ipcRenderer.send('desktop:request-surfaces');
  },
  onSurfaces(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('desktop:surfaces', listener);
    return () => ipcRenderer.removeListener('desktop:surfaces', listener);
  },
  onToggleMenu(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('desktop:toggle-menu', listener);
    return () => ipcRenderer.removeListener('desktop:toggle-menu', listener);
  },
  quit() {
    ipcRenderer.send('desktop:quit');
  },
}));
