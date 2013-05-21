var fs = require('fs');
var utils = require('./util.js');
var queue = require('queue-async');
var moment = require('moment');
var colors = require('colors');
var solrClient;
var verbose = 0;
var NOW = new Date().toISOString()

var config = { 
	hostTestName : 'check_fail2ban',
	defaultPeriod : 10,
	defaultUnits : 'hours',
	errorthreshold : 1400	// threshold for errored host
}

/**
 * 
 * Host management module
 * 
 */

var hosts = {
  /** 
   * 
   * Set invocation configuration. You probably want to do this.
   * 
   */
  setConfig : function(program, hostsFile, verbose, store) {
	config.hostsFile = hostsFile;
	config.program = program;
	verbose = verbose;
	solrClient = store.createClient(GLOBAL.CONFIG.solrConfig);

	return this;
 },

addHost : function(newHost, hosts) {
	var hp = getHostFromHosts(newHost, hosts);
	if (hp.host) {
		throw "host already exists: " + newHost;
	}

	var host = { name_s : newHost, added_dt : NOW, lastUpdate_dt : NOW, comment_s : config.program.comment};
	hp.hosts.push(host);
	hp.host = host;
	return hp;
},

/**
 * 
 * capture the remove event with the callback
 * 
 */
removeHost : function(removeHost, hosts, writeCallback) {
	var hp = getHostFromHosts(removeHost, hosts);
	if (!hp.host) {
		throw "host doesn't' exist: " + removeHost;
	}
	hp.host.removed_dt = NOW;
	writeCallback(hp);
	var newHosts = [];
	for (var i in hp.hosts) {
		var host = hp.hosts[i];
		if (!(host.name_s === removeHost)) {
			newHosts.push(host);
		}
	}
	hp.hosts = newHosts;
	hp.host = null;
	return hp;
},

setOnline : function(hostIn, hosts) {
	var hp = getHostFromHosts(hostIn, hosts);
	if (!hp.host) {
		throw "no such host: " + hostIn;
	}
	
	var host = hp.host;

	if (!isOffline(host)) {
		throw "host is not offline";
	}
				
	host.offline_b = false;
	host.online_dt = new Date().toISOString();
	host.comment_s = config.program.comment;
	return hp;
},

setOffline : function(hostIn, hosts) {
	var hp = getHostFromHosts(hostIn, hosts);
	if (!hp.host) {
		throw "no such host: " + hostIn;
	}
	var host = hp.host;

	if (isOffline(host)) {
		throw "host is already offline";
	}
	
	host.active_b = false;
	host.offline_b = true;
	host.offline_dt = new Date().toISOString();
	host.comment_s = config.program.comment;

	return hp;
},

activate : function(hostIn, hosts) {
	return activate(hostIn, hosts);
},

deactivate : function(hostIn, hosts) {
	return deactivate(hostIn, hosts);
},

advise : function(err, stats) {
	var advice = getRotateAdvice(stats);
	if (advice.removeActive === null || advice.addInactive === null) {
		throw "Can't advise" + JSON.stringify(advice);
	}
	console.log(process.argv[1] + ' --activate ' + advice.addInactive.name + ' --deactivate ' + advice.removeActive.name + ' -c "' + advice.summary + '"'); 
},

rotate : function(err, stats) {
	var advice = getRotateAdvice(stats);
	if (advice.removeActive === null || advice.addInactive === null) {
		throw "Can't rotate" + JSON.stringify(advice);
	}
	
	var hp = activate(advice.addInactive.name);
	hp = deactivate(advice.removeActive.name, hp.hosts);
	writeHosts(hp.hosts);	// FIXME: move storage to higher level
	console.log(advice.summary);
},

getStats : function(num, callback) {
	var worryVals = {OK : 0, WARNING : 10, CRITICAL : 30, UNKNOWN : 30};
	num = 0 + parseInt(num);
	
	var hosts = require(config.hostsFile);
	var nrpeChecks = require('./nrpe/allchecks.js').getChecks();
	
	var getStatsQueue = queue();
	var period = moment(moment() - moment().diff(num, config.defaultUnits)).format() + 'Z'; // FIXME use Date.toISOString();

	for (var n in nrpeChecks) {
		for (var h in hosts) {
			var host = hosts[h].name_s;
		
			getStatsQueue.defer(function(callback) {
				var statsQuery = solrClient.createQuery()
					.q({edge_s : host, aCheck_s : n, tickDate_dt : '[' + period + ' TO NOW]'}).sort({tickDate_dt:'asc'});
	
				solrClient.search(statsQuery, callback);
			}); 
		}
	}
	getStatsQueue.awaitAll(function(err, results) {
		if (err) {
			throw err;
		}
		
		var maxCount = 0;
		
		var hostSummaries = {};
		var averages = {inService : 0};
		for (var name in nrpeChecks) {
			for (var field in nrpeChecks[name].fields) {
				averages[field] = {sum : 0, count : 0};
			}
		}
	
		for (var r in results) {
			var response = results[r].response;
			
			for (var d in response.docs) {	// parse host results
			var doc = response.docs[d];
			var utc = moment.utc(doc.tickDate_dt);
			var host = doc['edge_s'];
	
			var hostSummary = hostSummaries[host];
			if (!hostSummary) {
				hostSummary = {worryWeight : 0, resultCount : 0};
				for (var name in nrpeChecks) {
					for (var field in nrpeChecks[name].fields) {
						hostSummary[field + 'Count'] = 0;
					}
				}
				hostSummaries[host] = hostSummary;
			}
	
			hostSummary['resultCount'] = hostSummary['resultCount'] + 1;
			if (hostSummary['resultCount'] > maxCount) {
				maxCount = hostSummary['resultCount'];
	        }
			var worry = 0;
			console.log(doc);
			var timeAgo = moment(doc['tickDate_dt']).fromNow();
			var timeWeight = Math.round(moment().diff(doc['tickDate_dt']) / 10000);
			if (doc.error_t) {
				var worry = timeWeight;	// decreases based on time; recent is
										// ~1400 - errorthreshold
				if (verbose) {
					console.log(host.red + ' from ' + timeAgo + ': ' + doc.error_t.replace('CHECK_NRPE: ', '').trim() + ' ' + doc.tickDate_dt + ' worryWeight', worry);
				}
			} else {
				for (var field in nrpeChecks[doc.aCheck_s].fields) {
					if (doc[field]) {
						hostSummary[field + 'Count'] = hostSummary[field + 'Count'] + doc[field];
						averages[field]['sum'] = averages[field]['sum'] + doc[field];
						averages[field]['count'] = averages[field]['count'] + 1;
					}
				}
				if (doc.status_s != 'OK' && !worryVals[doc.status_s]) {
					console.log('worryVals', worryVals);
					throw 'Missing worryVal for "' + doc.status_s + '"';
				}

				worry = worryVals[doc.status_s] * timeWeight;
				if (verbose) {
					console.log(host.yellow + ' from ' + timeAgo + ': ' + doc.status_s + ' worryWeight', worry);
				}
			}
			hostSummary.worryWeight = hostSummary.worryWeight + worry;
		}
	}
	
	for (var name in nrpeChecks) {
		for (var field in nrpeChecks[name].fields) {
			averages[field]['average'] = averages[field]['sum'] / averages[field]['count'];
		}
	}
	callback(null, { averages: averages, hostSummaries : hostSummaries});
	});
}, 

mustComment : function() {
	if (!config.program.comment) {
		throw "You must enter a comment. use --help for help.";
	}
},

writeHosts : function(hosts, changedHost) {
	return writeHosts(hosts, changedHost);
},

getHostSummaries : function() {
	return getHostSummaries();
}

}

hosts.config = config;

module.exports = hosts;

/**
**	Utilities
**
**/
	

function getRotateAdvice(stats) {
	var summaries = getHostSummaries();
	var averages = stats.averages;
	var hostSummaries = stats.hostSummaries;

	if (summaries.inactiveHosts < 1) {
		throw 'no inactive hosts to rotate with';
	}
	
	var removeActive;
	var addInactive;
	var removeReason;
	var addReason;

	var highestError = null;
	for (var i in summaries.activeHosts) { // get oldest active host to deactivate
		var host = summaries.activeHosts[i];
		if (config.program.rout) {
			if (config.program.rout === i) {
				removeActive = { name : i, stats : host};
				removeReason = 'request out';
			}
		} else {
			
			if (verbose) {
				console.log('removeActive'.yellow, i, removeActive ? (host.active_dt + ' vs ' + removeActive.stats.active_dt + ': ' 
						+ (moment(host.active_dt).diff(removeActive.stats.active_dt))) : 'null');
			}
			var rec = hostSummaries[i];
			
			if (rec && rec.worryWeight > 0 && (!highestError || rec.worryWeight > highestError.worryWeight)) {	// remove edge with highest error
				removeActive = { name : i, stats : host};
				highestError = rec;
				removeReason = 'error (' + rec.worryWeight + ')';
				if (verbose) {
					console.log('remove candidate; error:'.red, rec.worryWeight);
				}
			} else if (!highestError && (!removeActive || (moment(host.active_dt).diff(removeActive.stats.active_dt) < 0))) {	// or if no errors, longest time
				removeActive = { name : i, stats : host};
				removeReason = 'time';
				if (verbose) {
					console.log('remove candidate; time:'.orange, moment(removeActive.stats.active_dt).format("dddd, MMMM Do YYYY, h:mm:ss a"));
				}
			}
		}
	}
	
	var tries = summaries.inactive;
	var lowestError = null;	// use this host if no other option
	
	for (var i in summaries.inactiveHosts) { // get oldest inactive host to
												// activate
		var host = summaries.inactiveHosts[i];
		if (config.program.rin) {
			if (config.program.rin === i) {
				addInactive = { name : i, stats : host};
				addReason = 'request in';
			}
		} else {
		
			if (verbose) {
				if (!hostSummaries[i]) {
					console.log('addInactive'.yellow, i + ' no reports');
				} else {
					console.log('addInactive'.yellow, i + ' err: '.red + hostSummaries[i].worryWeight, addInactive ? (host.inactive_dt + ' vs ' + addInactive.stats.inactive_dt + ': ' 
						+ (moment(host.inactive_dt).diff(addInactive.stats.inactive_dt))) : 'null');
				}
			}
			if (!addInactive || (moment(host.inactive_dt).diff(addInactive.stats.inactive_dt) < 0)) {
				var rec = hostSummaries[i];
	
				if (rec && rec.worryWeight < 1) { // it has had reports and
													// they are perfect
					addInactive = { name : i, stats : host};
					addReason = 'time';
					if (verbose) {
						console.log("candidate; time: ".orange, moment(removeActive.stats.inactive_dt).format("dddd, MMMM Do YYYY, h:mm:ss a"));
					}
				} else {
					if (!lowestError || (rec && rec.worryWeight < lowestError.worryWeight)) {	// it has had reports and they are not the worst
						if (verbose) {
							console.log('lowest errored host:'.yellow, rec ? rec.worryWeight : 'no records');
						}
							
						lowestError = i;
					}
				}
			}
		}
	}
	
	if (!addInactive && lowestError && lowestError.erroWeight < config.errorthreshold) {
		addReason = 'low error';
		addInactive = { name : lowestError, stats : summaries.inactiveHosts[lowestError]};
	}
	
	if (config.program.rin && !addInactive) {
		throw "Can't rotate in " + program.rin;
	}
	
	if (config.program.rout && !removeActive) {
		throw "Can't rotate out " + config.program.rout;
	}
	
	if (!removeActive) {
		throw "no host to inactivate";
	}
	
	if (!addInactive) {
		throw "no host to activate";
	}
	
	return {removeActive : removeActive, addInactive : addInactive, removeReason : removeReason, addReason : addReason
		, summary : 'replace ' + removeActive.name + ' ' + removeActive.stats.since +  ' [' + removeReason + '] w ' + addInactive.name + ' ' + addInactive.stats.since + ' [' + addReason + ']'};
}


function getHostSummaries(hosts) {
  if (!hosts) {
	hosts = require(config.hostsFile);
  }
	
  var available = 0;
  var unavailable = 0;
  var offline = 0;
  var active = 0;
  var inactive = 0;
  var activeHosts = {};
  var inactiveHosts = {};
  var offlineHosts = {};
  var total = 0;

  for (var h in hosts) { 
    total++;
	var host = hosts[h];

	if (isAvailable(host)) {
	  available++;
	} else{
	  unavailable++;
	}
	if (isActive(host)) {
		active++;
		activeHosts[hosts[h].name_s] = { active_dt : host.active_dt, since : moment(host.active_dt).fromNow(), commment : hosts[h].comment_s };
	}
	if (isOffline(host)) {
		offline++;
		offlineHosts[hosts[h].name_s] = { offline_dt : host.offline_dt, since : moment(host.offline_dt).fromNow(), comment : hosts[h].comment_s };
	} else if (isInactive(host)) {
		inactive++;
		inactiveHosts[hosts[h].name_s] = { inactive_dt : host.inactive_dt, since : moment(host.inactive_dt).fromNow(), comment : hosts[h].comment_s };
	}
  }
  return { total : total, active : active, activeHosts: activeHosts, inactive : inactive, inactiveHosts: inactiveHosts, available : available, unavailable : unavailable, offline : offline, offlineHosts: offlineHosts, required : GLOBAL.CONFIG.minActive};
}

function validateConfiguration(hosts) {	// make sure the resulting config makes sense
	var stats = getHostSummaries(hosts);
	if (stats.active < GLOBAL.CONFIG.minActive) {
		if (program.override) {
			console.log("overridding required hosts");
		} else {
			throw "not enough active hosts; " + stats.active + ' (required: ' + GLOBAL.CONFIG.minActive + ')';
		}
	}
	if (GLOBAL.CONFIG.constantActive && stats.active != GLOBAL.CONFIG.constantActive) {
		if (program.override) {
			console.log("overridding required constant active");
		} else {
			throw "active hosts not required number; " + stats.active + ' (required: ' + GLOBAL.CONFIG.constantActive + ')';
		}
	}
	if (GLOBAL.CONFIG.minInactive  && stats.inactive < GLOBAL.CONFIG.minInactive) {
		if (program.override) {
			console.log("overridding required inactive");
		} else {
			throw "not enough inactive hosts; " + stats.inactive + ' (required: ' + GLOBAL.CONFIG.minInactive + ')';
		}
	}
}

function activate(hostIn, hosts) {
	var hp = getHostFromHosts(hostIn, hosts);
	if (!hp.host) {
		throw "no such host: " + hostIn;
	}
	var host = hp.host;

	if (isOffline(host)) {
		throw "host is offline";
	} else if (isActive(host)) {
		throw "host is already online";
	}
	host.active_b = true;
	host.active_dt = new Date().toISOString();
	host.comment_s = config.program.comment;
	return hp;
}

function deactivate(hostIn, hosts) {
	var hp = getHostFromHosts(hostIn, hosts);
	if (!hp.host) {
		throw "no such host: " + hostIn;
	}
	var host = hp.host;

	if (isOffline(host)) {
		throw "host is offline";
	} else if (isInactive(host)) {
		throw "host is already inactive";
	}
	
	host.active_b = false;
	host.inactive_dt = new Date().toISOString();
	host.comment_s = config.program.comment;
	return hp;
}
	
/**
 * 
 * Utilities
 * 
 */

function getHosts() {
	return require(hostsFile);
}


/** get host and updated hosts. retrieves hosts if not passed. * */

function getHostFromHosts(hostIn, hosts) {
	if (!hosts) {
		hosts = require(config.hostsFile);
	}
	for (var h in hosts) {
		var host = hosts[h];
		if (host.name_s === hostIn) {
			return { hosts : hosts, host : host, position: h};
		}
	}
	return { hosts : hosts};
}

function writeHosts(hosts, changedHost) {
	validateConfiguration(hosts);
	
	fs.writeFileSync(config.hostsFile, JSON.stringify(hosts, null, 2));
	if (config.flatHostsFile) {
		if (verbose) {
			console.log('writing to ' + config.flatHostsFile);
		}
		writeFlatHosts(hosts);
	}
	
	var sum = getHostSummaries(hosts);
	var summary = {comment_s : config.program.comment, operator_s : process.env.SUDO_USER || process.env.USER
       , active_i: sum.active, inactive_i: sum.inactive, offline_i: sum.offline
       , date_dt : new Date().toISOString(), class_s : 'edgemanage_test', id : new Date().getTime()};
	var docs = [summary];

	for (var i in hosts) {
		var host = hosts[i];
		if (changedHost && !changedHost === host.name_s) {
			continue;
		}
		
		var doc = {};
		for (var d in host) {
			if (host.hasOwnProperty(d)) {
				doc[d] = host[d];
			}
		}
			
		doc.date_dt = NOW;
		doc.class_s = 'host state';
		doc.id = host.name_s + '/' + NOW;
		docs.push(doc);
	}
	solrClient.add(docs, function(err,obj){
	  if(err){
	    throw "commit ERROR: " + err;
	  }
	});
}

/**
 * write complete list of hosts
 */
function writeFlatHosts(hosts, writeAll, file) {
	if (!file) {
		file = flatHostsFile;
		if (!file) {
			throw 'no flatHostsFile defined', flatHostsFile;
		}
	}

	var contents = writeAll ? '# complete list of hosts as of ' + new Date() + '\n' : "# do not edit this file directly, use edgemanage instead\n";
	for (var h in hosts) {
		var host = hosts[h];
		var line = null;
		var name = host.name_s;
		if (isActive(host) || writeAll) {
			line = name;
		} else if (isOffline(host)) {
			line = '# ' + host.comment_s + '\n#' + name;
		} else { // inactive
			line = '## ' + name;
		}
		contents += line + '\n';		
	}
	fs.writeFileSync(file, contents);
}

function isInactive(host) {
	return !host.active_b;
}

function isActive(host) {
	return host.active_b;
}

function isOffline(host) {
	return host.offline_b;
}

/**
 * 
 * Host is eligble to be active
 * 
 */

function isAvailable(host) {
	return (!isOffline(host));
}
