'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getData:     (provider) => ipcRenderer.invoke('get-data', provider),
  getFx:       ()         => ipcRenderer.invoke('get-fx'),
  getLogPaths: ()         => ipcRenderer.invoke('get-log-paths'),
  setCompact:  (compact)  => ipcRenderer.send('set-compact', compact),
  close:       ()         => ipcRenderer.send('close-window'),
  onDataChanged: (cb)     => ipcRenderer.on('data-changed', cb),
});
