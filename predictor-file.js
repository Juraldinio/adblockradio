// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Copyright (c) 2018 Alexandre Storelli

"use strict";
const { log } = require("abr-log")("predictor");
const { Readable } = require("stream");
const Hotlist = require("./predictor-db/hotlist.js");
const MlPredictor = require("./predictor-ml/ml.js");
const async = require("async");
const cp = require("child_process");
const fs = require("fs-extra");

class ChunkAudioRead extends Readable {
	constructor(options) {
		options.objectMode = true;
		super(options);

		this.file = options.file;
		this.records = options.records;
		this.predInterval = options.predInterval;
		const self = this;

		this.decoder = cp.spawn('ffmpeg', [
			'-i', 'pipe:0',
			'-acodec', 'pcm_s16le',
			'-ar', 22050,
			'-ac', 1,
			'-f', 'wav',
			'-v', 'fatal',
			'pipe:1'
		], { stdio: ['pipe', 'pipe', process.stderr] });

		if (this.file) {
			fs.createReadStream(self.file).pipe(this.decoder.stdin);
		} else if (this.records) {
			(async function read() {
				for (let i=0; i<self.records.length; i++) {
					const data = await fs.readFile(self.records[i]);
					const needToWaitDrain = !self.decoder.stdin.write(data);
					if (needToWaitDrain) {
						await new Promise(function(resolve) {
							self.decoder.stdin.once("drain", resolve);
						});
					}
				}
				self.decoder.stdin.end();
			})();
		}

		const bitrate = 22050 * 2; // bytes per second. (16 bit, single channel)
		const readAmount = Math.round(self.predInterval * bitrate);
		log.debug('readAmount=' + readAmount + ' bytes');
		let bytesRead = 0;
		this.decoder.stdout.on('readable', function() {
			let chunk;
			while (null !== (chunk = self.decoder.stdout.read(readAmount))) {
				//log.info('Append chunk of ' + readAmount + ' bytes of data.');

				bytesRead += chunk.length;
				self.push({
					data: chunk,
					tStart: Math.round((bytesRead - chunk.length) / (bitrate) * 1000), // in ms
					tEnd: Math.round(bytesRead / (bitrate) * 1000), // in ms
				});
			}
		});

		this.decoder.stdout.on('end', function() {
			log.info("decoding finished");
			self.push(null);
		});
	}

	_read() {
		// Le silence éternel de ces espaces infinis m’effraie.
	}
}

class PredictorFile {
	constructor(options) {
		// stream identification
		this.country = options.country;     // mandatory argument
		this.name = options.name;           // mandatory argument
		this.modelPath = options.modelPath; // mandatory argument - directory where ML models and hotlist DBs are stored

		// input file(s) - specify one, as a relative path
		this.file = options.file;           // arbitrary file to analyse
		this.records = options.records;     // relative paths of audio chunks, with partial records results in JSON.

		// output of predictions
		this.listener = options.listener;	// mandatory argument, instance of a Writable Stream.

		if (!this.country || !this.name || !this.listener || (!this.file && !this.records)) {
			return log.error("Predictor needs to be constructed with: country (string), name (string), listener (Writable stream) and (file (string) OR records (array of strings))");
		}

		// default module options
		this.config = {
			predInterval: 1, // send stream status to listener every N seconds
			saveDuration: 10, // save audio file and metadata every N **predInterval times**.
			enablePredictorMl: true, // perform machine learning inference (at "predInterval" intervals)
			enablePredictorHotlist: true, // compute audio fingerprints and search them in a DB (at "predInterval" intervals)
		}

		// optional custom config
		Object.assign(this.config, options.config);
		Object.assign(this.config, { file: undefined, records: undefined });

		if (this.file) {
			log.info("run predictor on file " + this.file + " with config=" + JSON.stringify(this.config));
		} else {
			log.info("run predictor on " + this.records.length + " records with config=" + JSON.stringify(Object.assign(this.config)));
		}

		this._onData = this._onData.bind(this);

		this.input = new ChunkAudioRead({ file: this.file, records: this.records, predInterval: this.config.predInterval });
		this.input.on("error", (err) => log.error("read err=" + err));
		this.input.pause();

		const self = this;

		this.input.on("data", function(dataObj) {
			if (self.records) {
				const i = Math.floor(dataObj.tStart / 1000 / self.config.predInterval / self.config.saveDuration);
				const s = self.records[i].split('.');
				dataObj.metadataPath = s.slice(0, s.length - 1).join("."); // remove audio extension
				log.debug("read " + dataObj.data.length + " bytes for file " + dataObj.metadataPath);
			}
			self._onData(dataObj);
		});

		this.input.on("end", function() {
			log.info("all data has been read");
			self.readFinished = true;
		});

		this.startPredictorHotlist();
		this.startPredictorMl(function() {
			self.input.resume()
		});
	}

	_onData(dataObj) {
		const self = this;
		this.input.pause();

		// TODO: do the hotlist search only if mlPredictor is unsure?

		async.parallel([

			function(cb) {
				if (!self.config.enablePredictorMl) return setImmediate(cb);
				self.mlPredictor.write(dataObj.data);
				self.mlPredictor.predict(cb);
			},
			function(cb) {
				if (!self.config.enablePredictorHotlist) return setImmediate(cb);
				self.hotlist.write(dataObj.data);
				self.hotlist.onFingers(cb);
			}

		], function(err) {
			if (err) log.warn("a predictor returned the following error: " + JSON.stringify(err));

			// we package all the results in listener's cache data into an object that will go in postProcessing
			self.listener.write(Object.assign(dataObj, {
				type: "fileChunk",
				metadataPath: (dataObj.metadataPath || self.config.file) + ".json"
			}));

			if (self.readFinished) {
				self.stopPredictors();
				self.listener.end();
			} else {
				self.input.resume();
			}
		});
	}

	startPredictorHotlist() {
		if (this.config.enablePredictorHotlist) {
			this.hotlist = new Hotlist({
				country: this.country,
				name: this.name,
				fileDB: this.modelPath + '/' + this.country + '_' + this.name + '.sqlite'
			});
			this.hotlist.pipe(this.listener);
		} else {
			this.hotlist = null;
		}
	}

	startPredictorMl(callback) {
		if (this.config.enablePredictorMl) {
			this.mlPredictor = new MlPredictor({
				country: this.country,
				name: this.name,
			});
			this.mlPredictor.load(this.modelPath + '/' + this.country + '_' + this.name + '.keras', function(err) {
				if (err) {
					log.error(err);
				}
				callback();
			});
			this.mlPredictor.pipe(this.listener);
		} else {
			this.mlPredictor = null;
		}
	}

	stopPredictors() {
		log.info("close predictor");
		if (this.hotlist) this.hotlist.end();
		if (this.mlPredictor) this.mlPredictor.end();
	}
}


module.exports = PredictorFile;