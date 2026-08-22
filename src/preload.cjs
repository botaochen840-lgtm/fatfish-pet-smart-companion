'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopPet', {
  bootstrap: () => ipcRenderer.invoke('pet:get-bootstrap'),
  manifest: () => ipcRenderer.invoke('pet:get-manifest'),
  config: () => ipcRenderer.invoke('pet:get-config'),
  refresh: () => ipcRenderer.invoke('pet:refresh'),
  interact: action => ipcRenderer.invoke('pet:interact', action),
  setClickThrough: ignored => ipcRenderer.send('pet:set-click-through', ignored),
  dragStart: point => ipcRenderer.send('pet:drag-start', point),
  dragMove: point => ipcRenderer.send('pet:drag-move', point),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  walkMove: dx => ipcRenderer.invoke('pet:walk-move', dx),
  resize: scale => ipcRenderer.invoke('pet:resize', scale),
  quit: () => ipcRenderer.send('pet:quit'),
  onSnapshot: listener => {
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on('pet:snapshot', handler)
    return () => ipcRenderer.removeListener('pet:snapshot', handler)
  },
  onConnection: listener => {
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on('pet:connection', handler)
    return () => ipcRenderer.removeListener('pet:connection', handler)
  },
})
