var hapi = require('hapi');
var Joi = require('joi');
var bunyan = require('bunyan');

//setup loggers
var cliLog = bunyan.createLogger({
	name: 'sarapis-cli', level: 'debug', streams: [{
		stream: process.stdout, level: 'debug'
	}, {path: './sarapis-cli.log', level: 'debug'}]
});

var restLog = bunyan.createLogger({
	name: 'sarapis-rest', level: 'debug', streams: [{
		stream: process.stdout, level: 'debug'
	}, {path: './sarapis-rest.log', level: 'debug'}]
});

if (process.env.NODE_ENV == 'test') {
	cliLog.level('error');
	restLog.level('error');
}
else if (process.env.NODE_ENV == 'production') {
	cliLog.level('info');
	restLog.level('info');
}

//process command line arguments
//skip this step if we're running tests
var argv = [];
if (process.env.NODE_ENV != 'test') {
	argv = require('yargs')
		.usage('Usage: $0 --solr-host [string] --solr-port [num]')
		.demand(['solr-host', 'solr-port'])
		.describe('solr-host', 'The host address of a Solr instance to connect to.')
		.describe('solr-port', 'The port of a Solr instance to connect to.')
		.describe('solr-rootpath', 'The root path to the solr instance (Default: /solr).')
		.describe('solr-core', 'The core name of a Solr instance to connect to.')
		.describe('valid-subpaths', 'Comma seperated subpaths of the solr host that should be accessible over the proxy.')
		.describe('solr-allow', 'The methods to be allowed on the Solr instance(s).')
		.describe('solr-deny', 'The parameters to be prohibited on the Solr instance(s).')
		.describe('proxy-port', 'The port of the Solr proxy.')
		.describe('sarapis-port', 'The port of this Sarapis server instance.')
		.version(function () {
			return require('./package.json').version;
		})
		.epilog('Copyright 2015 CPS Group\nhttp://cpsgroup.github.io/')
		.argv;
}
cliLog.info(argv);

//setup some sensible defaults for our variables
var SOLR_HOST = argv.solrHost || 'localhost';
var SOLR_PORT = argv.solrPort || 8983;
var SOLR_ROOTPATH = argv.solrRootpath || ['/solr'];
var SOLR_CORE = argv.solrCore;
var VALID_SUBPATHS = argv.validSubpaths;
var SOLR_VALID_METHODS = argv.solrAllow || ['GET', 'HEAD'];
var SOLR_INVALID_PARAMS = argv.solrDeny || ['qt', 'stream'];
var PROXY_HOST = argv.proxyHost || 'localhost';
var PROXY_PORT = argv.proxyPort || 9090;
var SARAPIS_PORT = argv.sarapisPort || 3000;

//Process the valid paths
var str = JSON.stringify(VALID_SUBPATHS);
str = str.replace(/\"/g, "");

var basicPath = SOLR_ROOTPATH;
var validPaths = '';

if (SOLR_CORE != undefined) {
	basicPath = basicPath + '/' + SOLR_CORE;
}

if (VALID_SUBPATHS == undefined) {
	basicPath = basicPath + '/select';
}else{
	str.split(',').forEach(function(validPath) {
		//Split the subpaths and create a comma seperated list of full valid paths with rootpath/core/subpath
		validPaths = basicPath + validPath + ',' + validPaths;
	});
}

cliLog.info("The valis paths are: " + validPaths);

//setup proxy options
var solrProxy = require('solr-proxy');
var solrProxyOptions = {
	listenPort: PROXY_PORT,
	validHttpMethods: SOLR_VALID_METHODS,
	validPaths: validPaths,
	invalidParams: SOLR_INVALID_PARAMS,
	backend: {
		host: SOLR_HOST,
		port: SOLR_PORT
	}
};

//setup our solr client against the proxy
var solrClient = require('solr-client');
var proxyClient = solrClient.createClient(PROXY_HOST, PROXY_PORT, SOLR_CORE, SOLR_ROOTPATH);

//setup basic options for our rest server
var restServer = new hapi.Server();
var server = restServer;
module.exports = server;
restServer.connection({port: SARAPIS_PORT, labels: ['api']});


//register rest routes
module.exports.registerRoutes = function () {
	//setup endpoints
	// pass on solr connection and log callback
	var solrQuery = require('./route/solr/query')(proxyClient, function (level, message) {
		restServer.log(level, message)
	});
	var base = require('./route/base');
	var adminInfo = require('./route/admin/info');
	var adminInspect = require('./route/admin/log/inspect');
	var adminSettings = require('./route/admin/log/settings');
	var web = require('./route/static/web');

	//add routes to server
	restServer.route(base.GET);
	restServer.route(solrQuery.GET);
	restServer.route(adminInfo.GET);
	restServer.route(adminInspect.GET);
	restServer.route(adminSettings.GET);
	restServer.route(adminSettings.POST);
	restServer.route(web.GET);
};


//register rest routes
module.exports.registerPlugins = function () {
	//setup plugins
	var bunyanPlugin = require('./plugin/bunyan')(restLog);
	var swaggerPlugins = require('./plugin/swagger');

	//add plugins to server
	restServer.register(bunyanPlugin, bunyanPlugin.callback);
	restServer.register(swaggerPlugins.core, swaggerPlugins.core.route, swaggerPlugins.core.error);
	restServer.register(swaggerPlugins.ui, swaggerPlugins.ui.route, swaggerPlugins.ui.error);
};

//finally startup proxy and rest server
//skip this step if loading this module from externally, e.g. for testing
if (!module.parent) {
	solrProxy.start(9090, solrProxyOptions); //the port option is mandatory even though being overwritten by the options

	module.exports.registerRoutes();
	module.exports.registerPlugins();

	restServer.start(function () {
		restServer.log('info', 'Server running at: ' + restServer.info.uri);
	});
}