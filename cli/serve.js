const VHCServer = require('../lib/server')
const http = require('http')
const https = require('https')
const fs = require('fs')

const config = JSON.parse(fs.readFileSync(process.argv[2]))
const vhc = new VHCServer(config)

vhc.on('ready',function(){
  console.log('VHC server ready')
})

const httpServer = http.createServer(vhc.serveRequest).listen(config.httpPort || 8000)

if(config.https){
  const httpsServer = https.createServer(
    {
      key: fs.readFileSync(config.https.keyFilename),
      cert: fs.readFileSync(config.https.certFilename),
      ca: fs.readFileSync(config.https.caFilename)
    },
    vhc.serveRequest
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