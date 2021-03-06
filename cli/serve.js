'use strict';
const VHCServer = require('../lib/server')
const MultipleHostVHCServer = require('../lib/multiple-host-server')
const http = require('http')
const https = require('https')
const fs = require('fs')
const fsp = require('fs-promise')
const program = require('commander')
const SekandoCloudClient = require('sekando-cloud-client')

program
  .version(require('../package.json').version)
  .option('--config-file <path>','Configuration file')
  .option('--sekando-cloud-project <project-id>','Sekando Cloud project ID')
  .option('--sekando-cloud-api-key <api-key>','Sekando Cloud API key secret')
  .option('--sekando-cloud-api-secret <secret>','Sekando Cloud API key secret')
  .option('--config-sekando-cloud-cluster-id <cluster-id>','Sekando Cloud cluster ID')
  .option('--config-sekando-cloud-member-id <member-id>','Sekando Cloud member ID')
  .option('--machine-id-file <path>','Path to file containing machine id (default: /etc/machine-id)')
  .option('--machine-id <machine-id>','Machine ID used for some API requests')
  .parse(process.argv)
  
let machineId = program.machineId
if(!machineId){
  const machineIdFile = program.machineIdFile || '/etc/machine-id'
  const exists = fs.existsSync(machineIdFile)
  if(exists){
    machineId = fs.readFileSync(machineIdFile).toString().split('\n')[0]
  }
}

const configFilename = program.configFile
const sekandoCloudProject = program.sekandoCloudProject

if(configFilename){
  startWithFilename(configFilename)
}
else if(sekandoCloudProject){
  startWithSekandoProject()
}
else{
  console.log('Configuration file or Sekando Cloud project ID required')
  return;
}

function startWithSekandoProject(){
  if(!machineId){
    console.log('Defining a machine ID is not required, but you should set one using --machine-id or --machine-id-file')
  }
  const sekando = new SekandoCloudClient({
    projectId: program.sekandoCloudProject,
    apiKey: program.sekandoCloudApiKey,
    apiSecret: program.sekandoCloudApiSecret,
    id: machineId
  })
  const clusterManager = sekando.clusterManager()
  const cluster = clusterManager.clusterWithId(program.configSekandoCloudClusterId)
  cluster.getMemberWithId(program.configSekandoCloudMemberId)
    .then(function(member){
      const config = JSON.parse(member.metadata)
      const mhvhcServer = start(config)
      member.on('change',function(){
        mhvhcServer.setConfig(JSON.parse(member.metadata))
      })
    })
    .catch(function(err){
      console.log(err)
    })
}

function startWithFilename(configFilename){
  const config = JSON.parse(fs.readFileSync(configFilename))
  
  const mhvhcServer = start(config)
  
  fs.watch(
    configFilename,
    {
      persistent: false
    },
    function(err,filename){
      updateConfig()
    }
  )
  
  function updateConfig(){
    fsp.readFile(configFilename)
    .then(function(contents){
      const config = JSON.parse(contents)
      mhvhcServer.setConfig(config)
    })
  }
}

function start(config){
  const mhvhcServer = new MultipleHostVHCServer(config)
  
  const httpServer = http.createServer(mhvhcServer.serveRequest).listen(config.httpPort || 8000)
  
  try {
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
  }
  catch(e){
    console.log(e)
  }
  
  
  process.on('SIGINT',function(){
    mhvhcServer.shutdown = true
  })
  
  process.on('SIGINT',function(){
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
  return mhvhcServer
}


