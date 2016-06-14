'use strict';
const crypto = require('crypto')
const fs = require('fs')
const Express = require('express')
const Git = require('nodegit')
const EventEmitter = require('events');
const path = require('path')
const fsp = require('fs-promise');
const compress = require('compression')
const minify = require('html-minifier').minify
var mkdirp = require('mkdirp');
var mkdirpPromise = require('mkdirp-promise')

class VHCServer extends EventEmitter{
  constructor(options) {
    super()
    const self = this
    this.versionsPath = options.versionsPath
    this.currentVersion = options.currentVersion || 'current'
    this.sourceGitPath = options.sourceGitPath
    this.gitSshPublicKey = options.gitSshPublicKey
    this.gitSshPrivateKey = options.gitSshPrivateKey
    this.gitSshPublicKeyMemory = options.gitSshPublicKeyMemory
    this.gitSshPrivateKeyMemory = options.gitSshPrivateKeyMemory
    this.gitSshPassphrase = options.gitSshPassphrase || ''
    this.gitRemoteUrl = options.gitRemoteUrl
    this.swCacheDirs = options.swCacheDirs || []
    this.swCacheNoHashDirs = options.swCacheNoHashDirs || []
    this.pathnameFileMap = options.pathnameFileMap || {}
    this.healthCheckPath = options.healthCheckPath || '/health_check'
    this.httpsRedirect = options.httpsRedirect
    this.pathPrefixFileMap = options.pathPrefixFileMap || {}
    this.sshKeyStageDir = options.sshKeyStageDir || '/tmp'
    this.host = options.host
    this.templateFiles = {}
    this.redirects = options.redirects
    this.rootDir = options.rootDir
    this.extensions = options.extensions
    
    const requiredParams = [
      'versionsPath',
      'sourceGitPath',
      'gitSshPrivateKey',
      'gitSshPublicKey',
      'gitRemoteUrl',
      'sourceGitPath',
      'versionsPath'
    ]
    
    for(let i = 0; i < requiredParams; i++){
      const param = requiredParams[i]
      if(!this[param]){
        throw new Error(param+' is required')
      }
    }
    
    this.ready = false
    
    this.renderedFiles = {}
    
    this.fetchOpts = {
      callbacks: {
        certificateCheck: function() { return 1; },
        credentials: function(url, userName) {
          return Git.Cred.sshKeyNew('git',path.resolve(self.gitSshPublicKey),path.resolve(self.gitSshPrivateKey),self.gitSshPassphrase)
        }
      },
      downloadTags: 1
    }
    
    this.availableVersions = {
      'current': this.sourceGitPath
    }
    
    this.express = Express()
    this.setupExpress()
    this.serveRequest = this.serveRequest.bind(this)
    
    // pull or clone the repository if we have one
    if(this.gitRemoteUrl){
      this.cloneOrPullRepository()
        .then(function(repository){
        }).then(function(){
          return self.checkoutVersions()
        })
        .then(function(versions){
          console.log('Versions: ',versions)
          return self.renderTemplates('current',self.sourceGitPath)
            .catch(function(err){
              console.log(err)
            })
        }).then(function(){
          console.log('Rendered current templates')
          self.emitReadyOrError()
          fs.watch(self.sourceGitPath,{
            recursive: true,
            persistent: false
          },function(err,filename){
            const fullPath = self.sourceGitPath+'/'+filename
            if(!self.renderedFiles[fullPath]){
              console.log(fullPath)
              self.renderTemplates('current',self.sourceGitPath,true).then(function(){
                console.log('Rendered current templates')
              }).catch(function(err){
                console.log(err)
              })
            }
          })
        })
        .catch(function(err){
          console.log(self.host,err)
          self.emit('error',err)
        })
    }
    else {
      process.nextTick(function(){
        self.emitReadyOrError()
      })
    }
  }
  
  emitReadyOrError() {
    if(this.gitRemoteUrl && this.availableVersions[this.currentVersion]){
      this.ready = true
      this.emit('ready')
    }
    else if(!this.gitRemoteUrl && this.redirects){
      console.log(this)
      // we have to repository, but we have redirects configured
      this.ready = true
      this.emit('ready')
    }
    else{
      this.emit('error',new Error('Selected version is not available'))
    }
  }
  
  serveRequest(req,res,next) {
    this.express(req,res,next)
  }
  
  setupExpress() {
    const self = this
    this.express.use(compress())
    if(this.httpsRedirect){
      this.express.use(function(req,res,next){
        const shouldRedirect = req.url != self.healthCheckPath
          && !req.secure
          && req.headers['x-forwarded-proto'] != 'https'
        if(shouldRedirect){
          res.redirect('https://'+req.headers.host+req.url)
        }
        else{
          next()
        }
      })
    }
    for(let path in self.pathPrefixFileMap){
      const filename = self.pathPrefixFileMap[path]
      self.express.use(path,function(req,res,next){
        const version = req.query.vhc_version || self.currentVersion
        const hash = req.params.hash
        const filePath = self.getFilePath(version,filename)
        res.sendFile(filePath)
      })
    }
    for(let path in self.redirects){
      const redirectConfig = self.redirects[path]
      self.express.use(path,function(req,res){
        let target = redirectConfig.target
        if(redirectConfig.appendPathname){
          target += req.url
        }
        res.redirect(target)
      })
    }
    this.express.use('/vhc/:version/:hash',function(req,res,next){
      const version = req.params.version
      const hash = req.params.hash
      const filename = req.url
      
      console.log(version)
      self.getOrCreateVersionDir(version)
        .then(function(versionDir){
          if(!versionDir){
            next();
            return;
          }
          
          res.header('cache-control','public, max-age=31556926')
          
          const mappedFile = self.pathnameFileMap[req.path]
          if(mappedFile){
            console.log(req.url,mappedFile)
            const filePath = self.getFilePath(version,mappedFile)
            res.sendFile(filePath)
            return;
          }
          
          let fullRootDir = versionDir
          if(self.rootDir){
            fullRootDir = versionDir+'/'+self.rootDir
          }
          
          const staticOptions = {}
          if(self.extensions){
            staticOptions.extensions = self.extensions
          }
          Express.static(fullRootDir,staticOptions)(req,res,next)
        })
    })
    this.express.use('/',function(req,res,next){
      const version = req.query.vhc_version || self.currentVersion
      const hash = req.params.hash
      const filename = req.url
      
      console.log(version)
      
      self.getOrCreateVersionDir(version)
        .then(function(versionDir){
          console.log()
          if(!versionDir){
            next();
            return;
          }
          
          const mappedFile = self.pathnameFileMap[req.path]
          console.log(req.url,req.path)
          if(mappedFile){
            console.log(req.url,mappedFile)
            const filePath = self.getFilePath(version,mappedFile)
            res.sendFile(filePath)
            return;
          }
          
          let fullRootDir = versionDir
          if(self.rootDir){
            fullRootDir = versionDir+'/'+self.rootDir
          }
          
          const staticOptions = {}
          if(self.extensions){
            staticOptions.extensions = self.extensions
          }
          Express.static(fullRootDir,staticOptions)(req,res,next)
        })
    })
    this.express.get(this.healthCheckPath,function(req,res){
      if(self.shutdown){
        res.status(500)
      }
      res.json({
        shutdown: !!self.shutdown
      })
    })
    this.express.post(this.healthCheckPath,function(req,res){
      if(self.shutdown){
        res.status(500)
      }
      res.json({
        shutdown: !!self.shutdown
      })
    })
  }
  
  getOrCreateVersionDir(version) {
    const self = this
    const versionDir = self.availableVersions[version]
    if(versionDir){
      return Promise.resolve(versionDir)
    }
    else{
      return self.cloneOrPullRepository()
        .then(function(){
          return self.checkoutVersions()
        })
        .then(function(){
          const versionDir = self.availableVersions[version]
          console.log('created version dir',versionDir)
          return Promise.resolve(versionDir)
        }).catch(function(err){
          // was probably already pulling
        }).then(function(versionDir){
          return Promise.resolve(versionDir)
        })
    }
  }
  
  stageMemorySshKeys() {
    // write ssh keys to disk because loading from memory does not work (yet?)
    const self = this
    if(!self.gitSshPrivateKeyMemory || !self.gitSshPublicKeyMemory){
      return Promise.resolve()
    }
    return fsp.mkdirs(self.sshKeyStageDir)
      .then(function(){
        const privateKeyPath = self.gitSshPrivateKey = self.sshKeyStageDir+'/key'
        return fsp.writeFile(privateKeyPath,self.gitSshPrivateKeyMemory)
      }).then(function(){
        const publicKeyPath = self.gitSshPublicKey = self.sshKeyStageDir+'/key.pub'
        return fsp.writeFile(publicKeyPath,self.gitSshPublicKeyMemory)
      })
  }
  
  isPulling() {
    return VHCServer.currentlyPulling[this.sourceGitPath]
  }
  
  startPulling() {
    VHCServer.currentlyPulling[this.sourceGitPath] = true
  }
  
  finishPulling() {
    VHCServer.currentlyPulling[this.sourceGitPath] = false
  }
  
  cloneOrPullRepository() {
    const self =this
    
    const cloneOptions = {}
    cloneOptions.fetchOpts = this.fetchOpts
    
    const isPulling = this.isPulling()
    if(isPulling){
      return Promise.reject(new Error('Already pulling repository'))
    }
    
    self.startPulling()
    
    // console.log(self.sourceGitPath)
    // @TODO check if .git exists too
    return self.stageMemorySshKeys()
      .then(function(){
        return fsp.exists(self.sourceGitPath)
      }).then(function(dirExists){
        if(dirExists){
          return fsp.exists(self.sourceGitPath+'/.git')
        }
        else{
          return Promise.resolve(false)
        }
      }).then(function(exists){
        if(exists){
          return self.pullRepository()
            .then(function(){
              self.finishPulling()
              return Promise.resolve()
            })
        }
        else{
          // console.log(cloneOptions)
          return mkdirpPromise(self.sourceGitPath)
            .then(function(){
              return Git.Clone(self.gitRemoteUrl, self.sourceGitPath, cloneOptions)
            })
            .then(function(){
              self.finishPulling()
              return Promise.resolve()
            })
        }
      }).catch(function(err){
        self.finishPulling()
        return Promise.reject(err)
      })
    
    return promise
  }
  
  pullRepository() {
    const self = this
    let repository = null
    return Git.Repository.open(self.sourceGitPath)
    .then(function(repo){
      repository = repo
      return repository.fetchAll(self.fetchOpts)
    }).then(function(){
      return repository.mergeBranches('master','origin/master')
    })
  }
  
  getRepository() {
    return Git.Repository.open(this.sourceGitPath)
  }
  
  checkoutVersions() {
    const self = this
    let versions;
    return self.getRepository().then(function(repository){
      return Git.Tag.list(repository)
    })
    .then(function(tags){
      versions = tags
      return self.checkoutVersionTags(tags,0)
    }).then(function(){
      return Promise.resolve(versions)
    })
  }
  
  checkoutVersionTags(tags,index) {
    const self = this
    if(index >= tags.length){
      return Promise.resolve()
    }
    else{
      const version = tags[index]
      return self.checkoutVersion(version)
        .catch(function(err){
          console.log(err)
        }).then(function(){
          return self.checkoutVersionTags(tags,index+1)
        })
    }
  }
  
  checkoutVersion(version) {
    console.log('Copying version '+version)
    const self = this
    let repository;
    const versionPath = self.versionsPath+'/'+version
    return self.getRepository().then(function(repo){
      repository = repo
      return repository.getTagByName(version)
    }).then(function(tag){
      return repository.getCommit(tag.targetId())
    }).catch(function(err){
      //because annotated and non-annotated commits are different
      return repository.getReferenceCommit(version)
    }).then(function(commit){
      return commit.getTree()
    }).then(function(tree){
      return new Promise(function(resolve,reject){
        const entries = []
        var walk = tree.walk(false)
        walk.on('entry',function(entry){
          entries.push(entry)
        })
        walk.on('error',function(err){
          reject(err)
        })
        walk.on('end',function(){
          resolve(entries)
        })
        walk.start()
      })
    }).then(function(entries){
      const promises = []
      
      entries.forEach(function(entry){
        const path = entry.path()
        const segs = path.split('/')
        const dir = segs.slice(0,-1).join('/')
        const fullDir = versionPath+'/'+dir
        const fullPath = versionPath+'/'+path
        // console.log(fullDir)
        // console.log(path)
        if(!entry.isDirectory()){
          promises.push(mkdirpPromise(fullDir).then(function(){
            return entry.getBlob()
          }).then(function(blob){
            // console.log(fullPath)
            return fsp.writeFile(fullPath,blob.content())
          }))
        }
      })
      return Promise.all(promises)
    }).then(function(){
      self.availableVersions[version] = versionPath
      return self.renderTemplates(version,versionPath)
    }).then(function(){
      console.log(self.availableVersions)
      return Promise.resolve()
    })
  }
  
  renderTemplates(version,fullPath,start) {
    const self = this
    if(start){
      if(self.templateFiles[version]){
        const promises = []
        self.templateFiles[version].forEach(function(fullPath){
          console.log(fullPath)
          promises.push(self.renderVersionTemplateFile(version,fullPath))
        })
        return Promise.all(promises);
      }
    }
    return fsp.stat(fullPath).then(function(stats){
      if(stats.isDirectory()){
        return fsp.readdir(fullPath).then(function(files){
          const promises = []
          files.forEach(function(file){
            if(file != '.git'){
              const childPath = fullPath +'/'+file
              // console.log('child',childPath)
              promises.push(self.renderTemplates(version,childPath))
            }
          })
          return Promise.all(promises)
        })
      }
      else{
        // console.log(fullPath)
        return self.renderVersionTemplateFile(version,fullPath)
      }
    })
  }
  
  renderVersionTemplateFile(version,fullPath) {
    const self = this
    const versionPath = self.availableVersions[version]
    const isTemplateFile = fullPath.match(/\.vhc$/)
    if(isTemplateFile){
      if(!this.templateFiles[version]){
        this.templateFiles[version] = []
      }
      if(this.templateFiles[version].indexOf(fullPath) == -1){
        this.templateFiles[version].push(fullPath)
      }
      console.log('Version/Hash Cache Template '+fullPath)
      const outputPath = fullPath.substr(0,fullPath.length-4)
      const extension = outputPath.split('.').slice(-1).join('')
      self.renderedFiles[outputPath] = fullPath
      return fsp.readFile(fullPath)
        .then(function(buff){
          let template = buff.toString()
          const tagRegExp = /\{vhc_path\}(.*)\{\/vhc_path\}/gi
          const vhcTagMatches = template.match(tagRegExp)||[]
          // console.log(version)
          // console.log(fullPath)
          // console.log(vhcTagMatches)
          
          const promises = []
          vhcTagMatches.forEach(function(tag){
            const inner = tag.replace(tagRegExp,"$1")
            const hashFilePath = versionPath+'/'+inner
            // console.log('inner',inner)
            // console.log(hashFilePath)
            promises.push(
              fsp.readFile(hashFilePath)
                .then(function(data){
                  const hash = crypto.createHash('md5')
                    .update(data, 'utf-8')
                    .digest('hex')
                  const vhcFilePath = '/vhc/'+version+'/'+hash+'/'+inner
                  template = template.split(tag).join(vhcFilePath)
                  return Promise.resolve()
                })
                .catch(function(err){
                  const vhcFilePath = '/vhc/'+version+'/'+version+'/'+inner
                  template = template.split(tag).join(vhcFilePath)
                  return Promise.resolve()
                })
            )
          })
          return Promise.all(promises).then(function(){
            return self.getSwCacheFiles(version)
          }).then(function(swCacheFiles){
            // console.log(swCacheFiles)
            template = template
              .split('{vhc_sw_paths}').join(JSON.stringify(swCacheFiles,2,2))
              .split('{vhc_version}').join(JSON.stringify(version))
            if(extension == 'html'){
              template = minify(template,{
                collapseWhitespace: true,
                minifyCSS: true
              })
            }
            return fsp.writeFile(outputPath,template)
              .then(function(){
                console.log('written')
                return Promise.resolve()
              })
          })
        })
    }
    else{
      return Promise.resolve()
    }
  }
  
  getSwCacheFiles(version){
    const self = this
    const promises = []
    self.swCacheDirs.forEach(function(dir){
      promises.push(self.getSwCacheFilesInDir(version,dir))
    })
    self.swCacheNoHashDirs.forEach(function(dir){
      promises.push(self.getSwCacheFilesInDir(version,dir,true))
    })
    return Promise.all(promises).then(function(results){
      const retval = []
      results.forEach(function(result){
        result.forEach(function(path){
          retval.push(path)
        })
      })
      return retval.sort((a,b) => {
        if (a.split('/').slice(4).join('/') < b.split('/').slice(4).join('/')){
          return 1;
        }
        else {
          return -1;
        }
        return 0;
      })
    })
  }
  
  getSwCacheFilesInDir(version,dir,noHash){
    const self = this
    // console.log(dir)
    const dirFullPath = self.getFilePath(version,dir)
    return fsp.walk(dirFullPath).then(function(files){
      if(noHash){
        const retval = []
        files.forEach(function(file){
          if(!file.stats.isDirectory()){
            const filename = file.path.split(dirFullPath).join('')
            if(filename.indexOf('/.DS_Store') == -1){
              retval.push('/'+dir+filename)
            }
          }
        })
        return Promise.resolve(retval)
      }
      else{
        const promises = []
        files.forEach(function(file){
          if(!file.stats.isDirectory()){
            const filename = file.path.split(dirFullPath).join('')
            if(filename.indexOf('/.DS_Store') == -1){
              promises.push(self.getVersionHashPath(version,dir+filename))
            }
          }
        })
        return Promise.all(promises)
      }
    })
  }
  
  getVersionHashPath(version,file){
    const self = this
    const fullPath = self.getFilePath(version,file)
    if(self.renderedFiles[fullPath]){
      // a file shouldn't hash itself because it will cause a weird paradox
      return Promise.resolve('/vhc/'+version+'/'+version+'/'+file)
    }
    return fsp.readFile(fullPath).then(function(data){
      const hash = crypto.createHash('md5')
      .update(data, 'utf-8')
      .digest('hex')
      const vhcFilePath = '/vhc/'+version+'/'+hash+'/'+file
      return Promise.resolve(vhcFilePath)
    }).catch(function(err){
      const vhcFilePath = '/vhc/'+version+'/oops/'+file
      return Promise.resolve(vhcFilePath)
    })
  }
  
  getFilePath(version,path){
    return this.availableVersions[version]+'/'+path
  }
}

VHCServer.currentlyPulling = {}

module.exports = VHCServer