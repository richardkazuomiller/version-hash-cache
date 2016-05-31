'use strict';
const VHCServer = require('../lib/server')
const MultipleHostVHCServer = require('../lib/multiple-host-server')
const http = require('http')
const https = require('https')
const fs = require('fs')

const configFilename = process.argv[2]

fs.watch(
  configFilename,
  {
    persistent: false
  },
  function(err,filename){
    console.log('----hoge----')
  }
)

const config = JSON.parse(fs.readFileSync(configFilename))

const mhvhcServer = new MultipleHostVHCServer(config)

const httpServer = http.createServer(mhvhcServer.serveRequest).listen(config.httpPort || 8000)

if(config.https){
  const httpsServer = https.createServer(
    {
      key: fs.readFileSync(config.https.keyFilename),
      cert: fs.readFileSync(config.https.certFilename),
      ca: fs.readFileSync(config.https.caFilename)
    },
    mhvhcServer.serveRequest
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