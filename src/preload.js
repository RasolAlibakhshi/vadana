const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listJobs: () => ipcRenderer.invoke('jobs:list'),
  createJob: (payload) => ipcRenderer.invoke('jobs:create', payload),
  runOnce: (jobId) => ipcRenderer.invoke('jobs:runOnce', jobId),
  deleteJob: (jobId) => ipcRenderer.invoke('jobs:delete', jobId),
  onLog: (cb) => ipcRenderer.on('job:log', (_, data) => cb(data))
});
