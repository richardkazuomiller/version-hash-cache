'use strict';
const VHCServer = require('../lib/server')

class MultipleHostVHCServer {
  constructor(config) {
    
    const self = this
    
    self.vhcServers = {}

    self.serveRequest = self.serveRequest.bind(this)

    self.setConfig(config)
  }
  
  setConfig(config) {
    const self = this
    for(let host in config.hosts){
      console.log(host)
      const hostConfig = config.hosts[host]
      if(hostConfig.alias){
        self.vhcServers[host] = {
          alias: hostConfig.alias
        }
      }
      else{
        const sshKeyStageDir = config.sshKeyStageDir || '/tmp'
        hostConfig.host = host
        hostConfig.sshKeyStageDir = sshKeyStageDir+'/'+host
        if(config.sourceDir){
          if(!hostConfig.versionsPath){
            hostConfig.versionsPath = config.sourceDir+'/'+host+'/versions'
          }
          if(!hostConfig.sourceGitPath){
            hostConfig.sourceGitPath = config.sourceDir+'/'+host+'/repository'
          }
        }
        const vhc = new VHCServer(hostConfig)
        vhc.on('ready',function(){
          console.log(hostConfig.host,'VHC server ready')
          self.vhcServers[host] = vhc
        })
        vhc.on('error',function(err){
          console.log(hostConfig.host,'error: ',err)
        })
      }
    }
  }
  
  serveRequest(req,res) {
    const self = this
    const vhc = self.getVHCServerForRequest(req)
    if(vhc){
      vhc.serveRequest(req,res)
    }
    else{
      res.statusCode = 404
      res.write('Not found')
      res.end()
    }
  }

  getVHCServerForRequest(req) {
    const self = this
    const hostHeader = req.headers.host || ''
    const host = hostHeader.split(':')[0]
    return self.getVHCServerForHost(host)
  }

  getVHCServerForHost(host) {
    const self = this
    const vhc = self.vhcServers[host] || self.vhcServers['default']
    if(vhc.alias){
      if(host != vhc.alias){
        return self.getVHCServerForHost(vhc.alias)
      }
      return null;
    }
    return vhc
  }
  
  get shutdown(){
    return this._shutdown
  }
  
  set shutdown(val){
    this._shutdown = val
    for(let host in this.vhcServers){
      const server = this.vhcServers[host]
      server.shutdown = val
    }
  }
}

module.exports = MultipleHostVHCServer