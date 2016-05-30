'use strict';
const VHCServer = require('../lib/server')
const http = require('http')
const https = require('https')
const fs = require('fs')

const vhcServers = {}

const config = JSON.parse(fs.readFileSync(process.argv[2]))

for(let host in config.hosts){
  console.log(host)
  const hostConfig = config.hosts[host]
  if(hostConfig.alias){
    vhcServers[host] = {
      alias: hostConfig.alias
    }
  }
  else{
    const sshKeyStageDir = config.sshKeyStageDir || '/tmp'
    hostConfig.host = host
    hostConfig.sshKeyStageDir = sshKeyStageDir+'/'+host
    const vhc = new VHCServer(hostConfig)
    vhc.on('ready',function(){
      console.log('VHC server ready')
    })
    vhcServers[host] = vhc
  }
}

console.log(vhcServers)

const httpServer = http.createServer(serveRequest).listen(config.httpPort || 8000)

if(config.https){
  const httpsServer = https.createServer(
    {
      key: fs.readFileSync(config.https.keyFilename),
      cert: fs.readFileSync(config.https.certFilename),
      ca: fs.readFileSync(config.https.caFilename)
    },
    serveRequest
  )
  httpsServer.listen(config.httpsPort)
  process.on('SIGINT',function(){
    shutdownServer(httpsServer,'HTTPS')
  })
}

process.on('SIGINT',function(){
  vhc.shutdown = true
  shutdownServer(httpServer,'HTTP')
})

function serveRequest(req,res){
  const vhc = getVHCServerForRequest(req)
  if(vhc){
    vhc.serveRequest(req,res)
  }
  else{
    res.statusCode = 404
    res.write('Not found')
    res.end()
  }
}

function getVHCServerForRequest(req){
  const hostHeader = req.headers.host || ''
  const host = hostHeader.split(':')[0]
  return getVHCServerForHost(host)
}

function getVHCServerForHost(host){
  const vhc = vhcServers[host] || vhcServers['default']
  if(vhc.alias){
    return getVHCServerForHost(vhc.alias)
  }
  return vhc
}

function shutdownServer(server,type){
  if(config.exitImmediately){
    console.log('Shutting down process')
    process.exit()
  }
  else{
    const serverCloseWaitTime = config.serverCloseWaitTime || 30000
    const shutdownTimeout = config.shutdownTimeout || 60000
    console.log('Closing '+type+' server in '+(serverCloseWaitTime/1000)+' seconds')
    setTimeout(function(){
      server.close()
      console.log('Waiting for '+type+' server to close ...')
      server.on('close',function(){
        console.log(type+' server closed.')
      })
    },serverCloseWaitTime)
    setTimeout(function(){
      console.log('Shutting down process after '+(shutdownTimeout/1000)+' seconds elapsed')
      process.exit()
    },shutdownTimeout).unref()
  }
}