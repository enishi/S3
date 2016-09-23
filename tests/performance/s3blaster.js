'use strict'; // eslint-disable-line strict

const errors = require('arsenal').errors;
const cluster = require('cluster');
const commander = require('commander');
const config = require('aws-sdk').config;
const S3 = require('aws-sdk').S3;
const crypto = require('crypto');
const fs = require('fs');
const stderr = process.stderr;

// available requests for testing
const requests = ['PUT-OBJ', 'LST-OBJ', 'GET-OBJ', 'DEL-OBJ', 'COM-OBJ'];
const avaiReq = [];
let idx = 0;
const PUT_OBJ = idx; avaiReq.push(idx++);
const LST_OBJ = idx; avaiReq.push(idx++);
const GET_OBJ = idx; avaiReq.push(idx++);
const DEL_OBJ = idx; avaiReq.push(idx++);
const COM_OBJ = idx; avaiReq.push(idx++);

/* simulaton schedule:
 *  (1) `Each`: in each `it` test, a request type and a data size is
 *     simulated for a given number of times before go to next one.
 *  (2) `Mixed`: in each `it` test, request and data size are chosen at
 *     random for testing.
 */
const simulEach = 'Each';
const simulMixed = 'Mixed';

const lastSlashIdx = process.argv[2].lastIndexOf('/');
const statsFolder = `./${process.argv[2].slice(0, lastSlashIdx)}/stats/`;
const calledFileName = process.argv[2].slice(lastSlashIdx + 1,
                        process.argv[2].length - 3);
let defaultFileName = `${statsFolder}` + `${calledFileName}`;

/**
 * stringify to a given length
 * @param {number/string} value: input variable
 * @param {number} length: desired output length
 * @return {string} string of at least given length
 */
function toFixedLength(value, length) {
    return (value.toString().length < length) ?
                        toFixedLength(` ${value}`, length) : value;
}

/**
 * function creates an array containing all `value`
 * @param {number} len: array length
 * @param {number} value: value for each element of array
 * @return {array} array of `len` elements `value`
 */
function createNewArray(len, value) {
    return Array.apply(null,
            new Array(len)).map(Number.prototype.valueOf, value);
}

function range(val) {
    const input = val.split(':').map(Number);
    const arr = [];
    for (let i = input[0]; i <= input[2]; i += input[1]) {
        arr.push(i);
    }
    return arr;
}

class S3Blaster {
    constructor(host, port) {
        commander.version('0.0.1')
        .option('-P, --port <port>', 'Port number', parseInt)
        .option('-H, --host [host]', 'Host name')
        .option('-N, --r-threads <a>:<b>:<c>', 'Threads range', range)
        .option('-n, --n-ops <nOps>', 'Number of operations', parseInt)
        .option('-u, --n-buckets <nBuckets>', 'Number of buckets', parseInt)
        .option('-B, --bucket-prefix [bucketPrefix]', 'Prefix for bucket name')
        .option('-s, --size <size>', 'Size of data', parseInt)
        .option('-w, --n-workers <nWorkers>', 'Workers number', parseInt)
        .parse(process.argv);
        this.host = (commander.host || host) || 'localhost';
        this.port = (commander.port || port) || 8000;
        this.rThreads = commander.rThreads || [1, 2];
        this.nOps = commander.nOps || 10;
        this.bucketPrefix = commander.bucketPrefix || 'foo';
        this.nBuckets = commander.nBuckets || 1;
        this.size = commander.size || 1024;
        this.nbDataSizes = commander.nbDataSizes || 1;
        Object.keys(this).forEach(opt => stderr.write(`${opt}=${this[opt]}\n`));
        config.apiVersions = { s3: '2006-03-01' };

        /* get number of workers */
        this.nWorkers = commander.nWorkers || 0;
        this.nProcesses = (this.nWorkers === 0) ? 1 : this.nWorkers;

        this.idWorker = '';
        if (cluster.isWorker) {
            this.idWorker = `${cluster.worker.id}`;
            defaultFileName += `_${this.idWorker}`;
        }
        this.bucketPrefix += `${this.idWorker}`;

        this.currThreadIdx = 0;
        this.nThreads = this.rThreads[this.currThreadIdx];
        this.initRThreads = this.rThreads;

        /* For ringr2-nodes */
        config.accessKeyId = '274BPZYBTQB169B2VEQT';
        config.secretAccessKey = '4MCRhc=SARh7jkEnYScKmSSVpsQpTvGsgPEkv/B5';
        /* For ringr2-connectors */
        // config.accessKeyId = 'LWLRW219AQG2ICKTIBTZ';
        // config.secretAccessKey = 'FONH2b/k4qKASfcdDAMhfnEWN24aCRLCBetHDVSr';
        /* For localhost */
        // config.accessKeyId = 'PXFZQV6ML8F8WEONVVTY';
        // config.secretAccessKey = 'e+7O2yLhKUX455/ryp3c4778Hp9Asbi8kNk3ij+a';

        config.endpoint = `${this.host}:${this.port}`;
        config.sslEnabled = false;
        config.s3ForcePathStyle = true;

        this.s3 = new S3();
        this.actionFlag = [];
        this.buckets = [];
        this.createdBucketsNb = 0;

        this.initNbOps = this.nOps;

        // data sizes
        this.sizes = [];
        for (let idx = 0; idx < this.nbDataSizes; idx++) {
            this.sizes.push(Math.pow(10, idx) * this.size);
        }
        // random data for tests
        this.values = this.sizes.map(size => crypto.randomBytes(size));

        this.currSizeIdx = 0;
        this.value = this.values[this.currSizeIdx];
        this.size = this.sizes[this.currSizeIdx];
        this.storedKeys = this.sizes.map(() => []);

        this.currActions = [];
        this.actionsNb = 0;
        this.actionIdx = 0;
        // available actions for test
        this.allActions = createNewArray(requests.length, 1);
        this.allActions[PUT_OBJ] = this.put.bind(this);
        this.allActions[GET_OBJ] = this.get.bind(this);
        this.allActions[DEL_OBJ] = this.del.bind(this);
        this.allActions[LST_OBJ] = this.list.bind(this);
        this.allActions[COM_OBJ] = this.comb.bind(this);
        this.actions = [];

        let idx = 0;
        this.reqsToTest = requests.map(() => idx++);
        this.threshold = this.nOps;

        /* for stats */
        this.count = 0;
        this.threads = 0;
        const zeroArr = createNewArray(this.nbDataSizes, 0);
        const infinityArr = [];
        for (let idx = 0; idx < this.nbDataSizes; idx++) {
            infinityArr.push(Infinity);
        }
        this.nSuccesses = requests.map(() => zeroArr.slice());
        this.nFailures = requests.map(() => zeroArr.slice());
        this.nBytes = requests.map(() => zeroArr.slice());
        this.latSum = requests.map(() => zeroArr.slice());
        this.latSumSq = requests.map(() => zeroArr.slice());
        this.latMin = requests.map(() => infinityArr.slice());
        this.latMax = requests.map(() => zeroArr.slice());
        this.dataToPlot = requests.map(() =>
            this.sizes.map(() => [])
        );
        this.dataForThreadPlot = '';

        this.resetStatsAfterEachTest = false;
        this.simulPolicy = simulEach;
        // this.freqsToShow = Math.max(Math.ceil(this.nOps / 100), 100);
        this.freqsToShow = 1;

        /* for output data files */
        try {
            fs.mkdirSync(statsFolder);
        } catch (e) {
            if (e.code !== 'EEXIST') {
                stderr.write(`cannot create '${statsFolder}' folder\n`);
                return;
            }
        }
        this.prefixName = '';
        this.suffixName = '';
        this.dataExt = '_dat.txt';
        this.funcExt = '_func.txt';
        this.sizeExt = '_size.txt';
        this.threadExt = '_thread.txt';
        this.dataFiles = requests.map(() => '');
        this.sizeFile = '';
        this.threadFile = '';

        /* For pdf and cdf */
        this.initFuncFiles = [`pdf${this.funcExt}`, `cdf${this.funcExt}`];
        this.funcFiles = this.initFuncFiles.slice();
        // for sampling latency
        this.step = 1; // ms
        this.samplesNb = 1000; // -> max lat = step * samplesNb

        this.zeroFunc = createNewArray(this.samplesNb, 0);
        this.pdf = requests.map(() =>
            this.sizes.map(() =>
                this.zeroFunc.slice()
            )
        );
        this.cdf = requests.map(() =>
            this.sizes.map(() =>
                this.zeroFunc.slice()
            )
        );

        this.latThread = undefined;
    }

    setParams(params) {
        if (params === undefined) return;
        if (params.nbBuckets !== undefined) {
            this.nBuckets = parseInt(params.nbBuckets, 10);
        }
        if (params.nbWorkers !== undefined && cluster.isMaster) {
            this.nWorkers = parseInt(params.nbWorkers, 10);
            this.nProcesses = (this.nWorkers === 0) ? 1 : this.nWorkers;
        }
        if (params.prefSufName !== undefined) {
            this.setPrefixSuffixName.bind(this)(params.prefSufName[0],
                                                params.prefSufName[1]);
        }
        /* Note: `nOps` must be set before `freqsToShow` and `simulPolicy`*/
        if (params.nOps !== undefined) {
            this.setNbOps.bind(this)(params.nOps);
        }
        /* Note: `reqsToTest` must be set before `distrFuncParams` */
        if (params.reqsToTest !== undefined) {
            this.setReqsToTest.bind(this)(params.reqsToTest);
        }
        if (params.distrFuncParams !== undefined) {
            this.setDistrFuncParams.bind(this)(params.distrFuncParams);
        }
        if (params.resetStatsAfterEachTest !== undefined) {
            this.setResetStatsFlag.bind(this)(params.resetStatsAfterEachTest);
        }
        if (params.simulPolicy !== undefined) {
            this.setSimulPolicy.bind(this)(params.simulPolicy);
        }
        if (params.freqsToShow !== undefined) {
            this.setFreqsToShow.bind(this)(params.freqsToShow);
        }
        if (params.sizes !== undefined) {
            this.setSizes.bind(this)(params.sizes);
        }
        if (params.arrThreads !== undefined) {
            this.setThreads.bind(this)(params.arrThreads);
        }
    }

    init(cb) {
        this.resetPdfCdf();
        this.reqsToTest.forEach(req => {
            this.resetDataStats.bind(this)(req);
        });
        this.createdBucketsNb = 0;
        this.createBuckets(err => {
            if (err) {
                return cb(err);
            }
            return this.createDataFiles(cb);
        });
    }

    /**
     * set sampling parameters
     * @param {array} distrFuncParams: [step, samplesNb] for latency sampling
     * @return {this} this
     */
    setDistrFuncParams(distrFuncParams) {
        if (distrFuncParams.constructor === Array) {
            if (distrFuncParams[0] > 0) {
                this.step = distrFuncParams[0];
            } else {
                stderr.write('1st element of distrFuncParams ' +
                             'must be a positive number\n');
            }
            if (distrFuncParams[1] > 0) {
                this.samplesNb = parseInt(distrFuncParams[1], 10);
                this.zeroFunc = createNewArray(this.samplesNb, 0);
            } else {
                stderr.write('2nd element of distrFuncParams ' +
                             'must be a positive integer\n');
            }
            this.resetPdfCdf.bind(this)();
        } else {
            stderr.write('input `distrFuncParams` must be an array ');
            stderr.write('[step, samplesNb]\n');
        }
    }

    setSimulPolicy(policy) {
        if (policy === simulEach || policy === simulMixed) {
            this.simulPolicy = policy;
        }
    }

    /**
     * set requests for each `it` test
     * @param {array} actions: array of integer values each of which
     *  corresponds to index of requests: PUT_OBJ, LST_OBJ, GET_OBJ, DEL_OBJ
     *  or COM_OBJ. It is used to create a mask to choose requests in
     *  this.reqsToTest for tests. The request defined by this.reqsToTest[idx]
     *  is chosen to test if this.actionFlag[idx] = true;
     * @return {this} this
     */
    setActions(actions) {
        this.currActions = [];
        this.actions = [];
        this.actionFlag = createNewArray(requests.length, -0);
        stderr.write('PID   #Threads   Action      Size    #OK  #NOK  ');
        stderr.write(`Min      Max      Average   Std. Dev.\n`);
        actions.forEach(action => {
            this.actionFlag[action] = true;
            this.actions.push(this.allActions[action]);
        });
        this.currActions = actions.slice();
        this.actionIdx = 0;
        this.actionsNb = this.currActions.length;
        this.threshold = this.nOps;
        if (this.simulPolicy === simulMixed) {
            this.threshold *= (this.currActions.length * this.sizes.length);
        }
        this.currSizeIdx = 0;
        this.value = this.values[this.currSizeIdx];
        this.size = this.sizes[this.currSizeIdx];
    }

    /**
     * set data sizes for tests
     * @param {array} sizes: array of data sizes
     * @return {this} this
     */
    setSizes(sizes) {
        if (sizes.constructor === Array) {
            this.sizes = sizes;
            this.size = sizes[0];
            this.values = sizes.map(size =>
                crypto.randomBytes(size)
            );
            if (sizes.length !== this.nbDataSizes) {
                this.storedKeys = this.sizes.map(() => []);
                this.nbDataSizes = sizes.length;
                this.reqsToTest.forEach(req => {
                    this.resetDataStats(req);
                });
                this.dataToPlot = requests.map(() =>
                    this.sizes.map(() => [])
                );
            }
        } else {
            stderr.write(`input 'sizes' must be an array of number\n`);
        }
    }

    /**
     * set array of number of threads for tests
     * @param {array} arrThreads: array of data sizes
     * @return {this} this
     */
    setThreads(arrThreads) {
        if (arrThreads.constructor === Array) {
            this.rThreads = arrThreads;
            this.currThreadIdx = 0;
            this.nThreads = arrThreads[0];
        } else {
            if (arrThreads < 0) {
                this.rThreads = this.initRThreads;
            } else {
                stderr.write(`input 'threads' must be an array of number\n`);
            }
        }
    }

    /**
     * set frequency to display/store stats
     * @param {number} nb: stats will be displayed/stored after `nb`
     *                      operations
     * @return {this} this
     */
    setFreqsToShow(nb) {
        if (nb > 0) {
            this.freqsToShow = Math.min(nb, this.nOps);
        }
    }

    /**
     * set flag to reset stats after each `it` test
     * @param {boolean} flag: `true` -> stats will be reset after each
     *                              `it` test. `false` is otherwise.
     * @return {this} this
     */
    setResetStatsFlag(flag) {
        this.resetStatsAfterEachTest = flag;
    }

    setPrefixSuffixName(prefixName, suffixName) {
        this.prefixName = prefixName || defaultFileName;
        this.suffixName = suffixName;
    }

    /**
     * set list of requests to test
     * @param {array} reqsToTest: array of requests to tests. It
     * @return {this} this
     */
    setReqsToTest(reqsToTest) {
        if (reqsToTest !== this.reqsToTest) {
            this.reqsToTest = [];
            reqsToTest.forEach(req => {
                if (avaiReq.indexOf(req) > -1) {
                    this.reqsToTest.push(req);
                } else {
                    stderr.write('input `reqsToTest` contains wrong ' +
                                    `request ${req}\n`);
                }
            });
            if (this.reqsToTest.length === 0) {
                throw new Error(`no request to test\n`);
            }
            this.dataToPlot = requests.map(() =>
                this.sizes.map(() => [])
            );
        }
    }

    setNbOps(nOps) {
        if (nOps !== this.nOps) {
            if (nOps > 0) {
                this.nOps = parseInt(nOps, 10);
            } else {
                this.nOps = this.initNbOps;
            }
            this.threshold = this.nOps;
            this.freqsToShow = Math.ceil(this.nOps / 10);
        }
    }

    /**
     * function creates files storing stats:
     *  - average and standard
     *  - estimated pdf & cdf
     *  - latency vs. sizes
     *  deviation of request latency
     * @param {function} cb: callback function
     * @return {function} callback
     */
    createDataFiles(cb) {
        this.dataFiles = requests.map(() => '');
        this.reqsToTest.forEach(reqIdx => {
            const dataFile = this.prefixName + requests[reqIdx] +
                             this.suffixName + this.dataExt;
            this.dataFiles[reqIdx] = dataFile;
        });
        this.funcFiles.forEach((funcFile, idx) => {
            this.funcFiles[idx] = this.prefixName + this.initFuncFiles[idx];
        });
        this.sizeFile = this.prefixName + this.suffixName + this.sizeExt;
        this.threadFile = this.prefixName + this.suffixName + this.threadExt;
        const outputDataFiles = [this.dataFiles, this.funcFiles,
                                 this.sizeFile, this.threadFile];
        function createAvgStdFiles(cb) {
            let count = 0;
            const label =
                '  nb_OK     Average    Std.-dev.  ||';
            let content = `# Configuration info\n`;
            /* add metadata info */
            content += `# host ${this.host}:${this.port}\n`;
            content += `# bucketsNb ${this.nBuckets}\n`;
            content += `# processesNb ${this.nProcesses}\n`;
            content += `# threadsNb ${this.nThreads}\n`;
            content += `# nOps ${this.threshold}\n`;
            content += '# sizes';
            this.sizes.forEach(size => {
                content += ` ${size}`;
            });
            content += `\n# requests`;
            this.reqsToTest.forEach(req => {
                content += ` ${req}`;
            });
            content += `\n# End_configuration\n`;
            /* add column headers*/
            content += '# Size  ';
            this.sizes.forEach(size => {
                const len = (label.length - size.toString().length) / 2;
                const space = toFixedLength(' ', len);
                content += space + size.toString() + space;
            });
            content += `\n#`;
            this.sizes.forEach(() => {
                content += label;
            });
            content += `\n`;
            /* create files */
            const realDataFiles = [];
            this.reqsToTest.forEach(reqIdx => {
                const dataFile = this.dataFiles[reqIdx];
                realDataFiles.push(dataFile);
                fs.writeFile(dataFile, content, err => {
                    if (err) {
                        cb(err); return;
                    }
                    count += 1;
                    if (count === this.reqsToTest.length) {
                        cb(null, realDataFiles); return;
                    }
                });
            });
        }

        function createSizeFile(cb) {
            const minSize = Math.min.apply(Math, this.sizes);
            const maxSize = Math.max.apply(Math, this.sizes);
            let content = `# Configuration info\n`;
            /* add metadata info */
            content += `# host ${this.host}:${this.port}\n`;
            content += `# bucketsNb ${this.nBuckets}\n`;
            content += `# processesNb ${this.nProcesses}\n`;
            content += `# threadsNb ${this.nThreads}\n`;
            content += `# nOps ${this.threshold}\n`;
            content += `# statSizes ${minSize} ${maxSize} ` +
                                            `${this.nbDataSizes}\n`;
            content += '# requests';
            this.reqsToTest.forEach(req => {
                content += ` ${req}`;
            });
            content += `\n# End_configuration\n`;
            /* add column headers*/
            content += `# ${toFixedLength('Size', 8)} `;
            this.reqsToTest.forEach(req => {
                content += ` ${toFixedLength(requests[req], 16)} `;
            });
            content += `\n`;
            /* create files */
            fs.writeFile(this.sizeFile, content, cb);
        }

        function createFuncFiles(cb) {
            let count = 0;
            this.funcFiles.forEach(funcFile => {
                fs.writeFile(funcFile, `#\n`, err => {
                    if (err) {
                        cb(err); return;
                    }
                    count += 1;
                    if (count === this.funcFiles.length) {
                        cb(); return;
                    }
                });
            });
        }

        function createThreadFile(cb) {
            let content = `# Configuration info\n`;
            /* add metadata info */
            content += `# host ${this.host}:${this.port}\n`;
            content += `# bucketsNb ${this.nBuckets}\n`;
            content += `# processesNb ${this.nProcesses}\n`;
            content += `# nOps ${this.threshold}\n`;
            content += '# sizes';
            this.sizes.forEach(dataSize => {
                content += ` ${dataSize}`;
            });
            content += `\n# threads `;
            this.rThreads.forEach(threadsNb => {
                content += ` ${threadsNb}`;
            });
            content += `\n# requests`;
            this.reqsToTest.forEach(req => {
                content += ` ${req}`;
            });
            content += `\n# End_configuration\n`;
            /* add column headers*/
            content += `# ${toFixedLength('#Thread', 8)} ` +
                       `${toFixedLength('Size', 8)} `;
            this.reqsToTest.forEach(req => {
                content += ` ${toFixedLength(requests[req], 16)} `;
            });
            content += `\n`;
            /* create files */
            fs.writeFile(this.threadFile, content, cb);
        }

        let count = 0;
        const totalFilesType = 4;
        createAvgStdFiles.bind(this)((err, dataFiles) => {
            if (err) {
                cb(err); return;
            }
            count += 1;
            outputDataFiles.splice(0, 1, dataFiles);
            if (count === totalFilesType) {
                cb(null, outputDataFiles); return;
            }
        });

        createSizeFile.bind(this)(err => {
            if (err) {
                cb(err); return;
            }
            count += 1;
            if (count === totalFilesType) {
                cb(null, outputDataFiles); return;
            }
        });

        createFuncFiles.bind(this)(err => {
            if (err) {
                cb(err); return;
            }
            count += 1;
            if (count === totalFilesType) {
                cb(null, outputDataFiles); return;
            }
        });

        createThreadFile.bind(this)(err => {
            if (err) {
                cb(err); return;
            }
            count += 1;
            if (count === totalFilesType) {
                cb(null, outputDataFiles); return;
            }
        });
    }

    printStats(idx) {
        const nSuccesses = this.nSuccesses[idx][this.currSizeIdx];
        const nFailures = this.nFailures[idx][this.currSizeIdx];
        const latMu = this.latSum[idx][this.currSizeIdx] / nSuccesses;
        const latSigma = Math.sqrt(this.latSumSq[idx][this.currSizeIdx] /
                                    nSuccesses - latMu * latMu);
        const latMin = this.latMin[idx][this.currSizeIdx].toFixed(3);
        const latMax = this.latMax[idx][this.currSizeIdx].toFixed(3);
        stderr.write(`${toFixedLength(process.pid, 6)}  `);
        stderr.write(`${toFixedLength(this.nThreads, 6)}  `);
        stderr.write(`${toFixedLength(requests[idx], 6)} `);
        stderr.write(`${toFixedLength(this.size, 8)} `);
        stderr.write(`${toFixedLength(nSuccesses, 6)} `);
        stderr.write(`${toFixedLength(nFailures, 4)} `);
        stderr.write(`${toFixedLength(latMin, 8)} `);
        stderr.write(`${toFixedLength(latMax, 8)} `);
        stderr.write(`${toFixedLength(latMu.toFixed(3), 8)} `);
        stderr.write(`${toFixedLength(latSigma.toFixed(3), 8)}\n`);
        const valuesToPlot =
            [nSuccesses, latMu.toFixed(3), latSigma.toFixed(5),
                this.nThreads.toFixed(3)];
        this.dataToPlot[idx][this.currSizeIdx].push(valuesToPlot);
    }

    /**
     * Configuration info is stored on top of the file
     * Data was stored with the structure of columns
     * - 1st col: #OK
     * - 2nd col: average value
     * - 3rd col: standard deviation
     * Each group of three columns corresponds to a data size
     * @param {function} cb: callback function
     * @return {function} callback
     */
    updateDataFiles(cb) {
        let count = 0;
        this.reqsToTest.forEach(actIdx => {
            const dataFile = this.dataFiles[actIdx];
            let nbPoints = this.dataToPlot[actIdx][0].length;
            this.dataToPlot[actIdx].forEach(data => {
                nbPoints = Math.min(nbPoints, data.length);
            });
            let dataContent = '';
            for (let point = 0; point < nbPoints; point++) {
                for (let idx = 0; idx < this.nbDataSizes; idx++) {
                    const value = this.dataToPlot[actIdx][idx][point];
                    dataContent = `${dataContent}` + `${value[0]}   ` +
                                    `${value[1]}   ` + `${value[2]}   `;
                }
                dataContent += `\n`;
            }
            fs.appendFile(dataFile, dataContent, err => {
                if (err) {
                    cb(err); return;
                }
                count += 1;
                if (count === this.currActions.length) {
                    if (this.resetStatsAfterEachTest) {
                        this.resetDataToPlot(cb);
                    } else {
                        cb();
                    }
                }
            });
        });
    }

    /**
     * Configuration info is stored on top of the file
     * Data was stored with the structure of columns. First column
     *  contains number presenting latency sizes. Next columns are
     *  group by requet types for test. Each group corresponds to
     *  a data size.
     * @param {function} cb: callback function
     * @return {function} callback
     */
    updateFuncFiles(cb) {
        /* compute pdf and cdf */
        this.finalizePdfCdf();
        let count = 0;
        const funcArr = [this.pdf, this.cdf];
        let dataContent;

        this.funcFiles.forEach((file, fileIdx) => {
            dataContent = `# Configuration info\n`;
            /* add metadata info */
            dataContent += `# host ${this.host}:${this.port}\n`;
            dataContent += `# bucketsNb ${this.nBuckets}\n`;
            dataContent += `# processesNb ${this.nProcesses}\n`;
            dataContent += `# threadsNb ${this.nThreads}\n`;
            dataContent += `# nOps ${this.threshold}\n`;
            dataContent += '# sizes';
            this.sizes.forEach(size => {
                dataContent += ` ${size}`;
            });
            dataContent += `\n# requests`;
            this.reqsToTest.forEach(req => {
                dataContent += ` ${req}`;
            });
            // min value for each column
            dataContent += `\n# min`;
            this.sizes.forEach((size, idx) => {
                this.reqsToTest.forEach(req => {
                    const min = Math.floor(this.latMin[req][idx] / this.step) *
                                    this.step;
                    dataContent += ` ${min.toFixed(2)}`;
                });
            });
            dataContent += `\n# max`;
            this.sizes.forEach((size, idx) => {
                this.reqsToTest.forEach(req => {
                    const max = Math.floor(this.latMax[req][idx] / this.step) *
                                    this.step;
                    dataContent += ` ${max.toFixed(2)}`;
                });
            });
            dataContent += `\n# mu`;
            this.sizes.forEach((size, idx) => {
                this.reqsToTest.forEach(req => {
                    const mu = this.latSum[req][idx] /
                               this.nSuccesses[req][idx];
                    dataContent += ` ${mu.toFixed(2)}`;
                });
            });
            dataContent += `\n# sigma`;
            this.sizes.forEach((size, idx) => {
                this.reqsToTest.forEach(req => {
                    const mu = this.latSum[req][idx] /
                               this.nSuccesses[req][idx];
                    const sigma = Math.sqrt(this.latSumSq[req][idx] /
                            this.nSuccesses[req][idx] - mu * mu);
                    dataContent += ` ${sigma.toFixed(2)}`;
                });
            });
            dataContent += `\n# End_configuration\n`;
            /* add column headers*/
            dataContent += '# Data size';
            let label = '';
            this.reqsToTest.forEach(idx => {
                label += `${requests[idx]}  `;
            });
            this.sizes.forEach(size => {
                const len = (label.length - size.toString().length) / 2;
                const space = toFixedLength(' ', len);
                dataContent += space + size.toString() + space;
            });
            dataContent += `\n# Latency `;
            this.sizes.forEach(() => {
                dataContent += label;
            });
            dataContent += `\n`;
            fs.writeFile(file, dataContent, err => {
                if (err) {
                    cb(err); return;
                }
                /* distribution function */
                dataContent = '';
                for (let idx = 0; idx < this.samplesNb; idx++) {
                    dataContent +=
                        `${toFixedLength((this.step * idx).toFixed(1), 9)} `;
                    for (let sizeIdx = 0; sizeIdx < this.sizes.length;
                        sizeIdx++) {
                        this.reqsToTest.forEach(req => { // eslint-disable-line
                            const lat =
                                funcArr[fileIdx][req][sizeIdx][idx].
                                                        toFixed(3);
                            dataContent += `${toFixedLength(lat, 7)}  `;
                        });
                    }
                    dataContent += `\n`;
                }
                fs.appendFile(file, dataContent, err => {
                    if (err) {
                        cb(err); return;
                    }
                    count += 1;
                    if (count === this.funcFiles.length) {
                        cb(); return;
                    }
                });
            });
        });
    }

    /**
     * Configuration info is stored on top of the file
     * Data was stored with the structure of columns. First column
     *  contains data sizes. Next columns are group by two
     * - 1st col: average value
     * - 2nd col: standard deviation
     * Each group of two columns corresponds to a request type
     * @param {function} cb: callback function
     * @return {function} callback
     */
    updateSizeFile(cb) {
        let dataContent = '';
        this.sizes.forEach((size, sizeIdx) => {
            dataContent += `${toFixedLength(size, 10)} `;
            this.reqsToTest.forEach(actIdx => {
                const arr = this.dataToPlot[actIdx][sizeIdx][
                                this.dataToPlot[actIdx][sizeIdx].length - 1];
                if (arr && arr.length > 2) {
                    dataContent += `${toFixedLength(arr[1], 8)} ` +
                                   `${toFixedLength(arr[2], 8)} `;
                }
            });
            dataContent += `\n`;
        });
        fs.appendFile(this.sizeFile, dataContent, cb);
    }

    /**
     * Configuration info is stored on top of the file
     * Data was stored with the structure of columns. First column
     *  contains number of threads. Second column contains data size.
     *  Next columns are group by two
     * - 1st col: average value
     * - 2nd col: standard deviation
     * Each group of two columns corresponds to a request type
     * @param {number} reqIdx: index of current request (optinal)
     * @return {function} callback
     */
    updateThreadStats() {
        let dataContent = '';
        this.sizes.forEach((size, sizeIdx) => {
            dataContent += `${toFixedLength(this.nThreads, 10)}` +
                           `${toFixedLength(size, 8)} `;
            this.reqsToTest.forEach(actIdx => {
                const arr = this.dataToPlot[actIdx][sizeIdx][
                            this.dataToPlot[actIdx][sizeIdx].length - 1];
                if (arr && arr.length > 2) {
                    if (this.currActions.indexOf(actIdx) === -1) {
                        dataContent += `${toFixedLength('?1/0', 8)} ` +
                                       `${toFixedLength('?1/0', 8)} `;
                    } else {
                        dataContent += `${toFixedLength(arr[1], 8)} ` +
                                       `${toFixedLength(arr[2], 8)} `;
                    }
                }
            });
            dataContent += `\n`;
        });
        this.dataForThreadPlot += dataContent;
    }

    updateThreadFile(cb) {
        fs.appendFile(this.threadFile, this.dataForThreadPlot, cb);
    }

    updateStatsFiles(cb) {
        const nbStatsFile = 3;
        let count = 0;
        this.updateFuncFiles.bind(this)(err => {
            if (err) {
                cb(err); return;
            }
            count += 1;
            if (count === nbStatsFile) {
                cb(); return;
            }
        });

        this.updateSizeFile.bind(this)(err => {
            if (err) {
                cb(err); return;
            }
            count += 1;
            if (count === nbStatsFile) {
                cb(); return;
            }
        });

        this.updateThreadFile.bind(this)(err => {
            if (err) {
                cb(err); return;
            }
            this.dataForThreadPlot = '';
            count += 1;
            if (count === nbStatsFile) {
                cb(); return;
            }
        });
    }

    resetStats(idx) {
        this.count = 0;
        this.threads = 0;
        if (this.resetStatsAfterEachTest || this.rThreads.length > 1) {
            this.resetDataStats.bind(this)(idx);
        }
    }

    resetDataStats(req) {
        const zeroArr = createNewArray(this.nbDataSizes, 0);
        const infinityArr = [];
        for (let idx = 0; idx < this.nbDataSizes; idx++) {
            infinityArr.push(Infinity);
        }
        this.latSum[req] = zeroArr.slice();
        this.latSumSq[req] = zeroArr.slice();
        this.nBytes[req] = zeroArr.slice();
        this.nSuccesses[req] = zeroArr.slice();
        this.nFailures[req] = zeroArr.slice();
        this.latMin[req] = infinityArr.slice();
        this.latMax[req] = zeroArr.slice();
        if (this.resetStatsAfterEachTest) {
            this.pdf[req] = this.sizes.map(() =>
                this.zeroFunc.slice()
            );
            this.cdf[req] = this.sizes.map(() =>
                this.zeroFunc.slice()
            );
        }
    }

    resetPdfCdf() {
        this.pdf = requests.map(() =>
            this.sizes.map(() =>
                this.zeroFunc.slice()
            )
        );
        this.cdf = requests.map(() =>
            this.sizes.map(() =>
                this.zeroFunc.slice()
            )
        );
    }

    resetDataToPlot(cb) {
        this.reqsToTest.forEach((req, reqIdx) => {
            this.sizes.forEach((size, sizeIdx) => {
                this.dataToPlot[reqIdx][sizeIdx] = [];
            });
        });
        cb();
    }

    createBucket(bucketName, cb) {
        const begin = process.hrtime();
        this.s3.createBucket({ Bucket: bucketName }, err => {
            const end = process.hrtime(begin);
            if (!err) {
                return cb(null, end);
            }
            stderr.write(`createBucket: ${err.code}..`);
            return cb(err.code === errors.BucketAlreadyExists.message ?
                        null : err.code);
        });
    }

    deleteBucket(bucketName, cb) {
        const begin = process.hrtime();
        this.s3.deleteBucket({ Bucket: bucketName }, err => {
            const end = process.hrtime(begin);
            if (err) {
                stderr.write(`deleteBucket: ${err}\n`);
                return cb(err);
            }
            return cb(null, end);
        });
    }

    listAllObjects(bucketName, callback, prefix, marker, lat, totalNbObjs) {
        this.listObject(bucketName, (err, value, time, nObjs, nextMarker) => {
            if (!err) {
                if (nextMarker) {
                    // stderr.write(`-> ${(time / nObjs).toFixed(3)}ms\n`);
                    return this.listAllObjects(bucketName, callback, prefix,
                                            nextMarker, time, nObjs);
                }
                return callback(null, value, lat / nObjs);
            }
            return callback(err);
        }, null, prefix, marker, lat, totalNbObjs);
    }

    listObject(bucketName, callback, maxKeys, prefix, marker, cumLat, nObjs) {
        const params = {
            Bucket: bucketName,
            MaxKeys: maxKeys || 1000,
            Prefix: prefix,
            Marker: marker,
        };
        const begin = process.hrtime();
        this.s3.listObjects(params, (err, value) => {
            const end = process.hrtime(begin);
            if (!err) {
                let nextMarker;
                const currNbObjs = value.Contents.length;
                if (currNbObjs === 0) {
                    return callback(null, value, cumLat, nObjs);
                }
                if (value.IsTruncated) {
                    nextMarker = value.Contents[currNbObjs - 1].Key;
                }
                let lat = (end[0] * 1e3 + end[1] / 1e6);
            // stderr.write(`${marker}: ${(lat / currNbObjs).toFixed(3)}ms`);
                lat += cumLat;
                const newNbObjs = nObjs + currNbObjs;
                return callback(null, value, lat, newNbObjs, nextMarker);
            }
            stderr.write(`list ${bucketName} NOK: `);
            stderr.write(`${err.code} ${err.message}\n`);
            return callback(err);
        });
    }

    putObject(bucketName, data, callback) {
        const object = {
            Bucket: bucketName,
            Key: data.key,
            Body: data.data,
        };
        const storedKey = {
            Bucket: bucketName,
            Key: data.key,
            SizeIdx: data.sizeIdx,
        };
        const begin = process.hrtime();
        this.s3.putObject(object, (err, value) => {
            const end = process.hrtime(begin);
            const lat = end[0] * 1e3 + end[1] / 1e6;
            if (!err) {
                return callback(null, value, storedKey, lat);
            }
            stderr.write(`put ${data.key} in ${bucketName} NOK: `);
            stderr.write(`${err.code} ${err.message}\n`);
            return callback(err, value);
        });
    }

    getObject(bucketName, key, callback, sizeIdx) {
        const params = {
            Bucket: bucketName,
            Key: key,
        };
        const begin = process.hrtime();
        this.s3.getObject(params, (err, data) => {
            const end = process.hrtime(begin);
            const lat = end[0] * 1e3 + end[1] / 1e6;
            if (!err) {
                return callback(null, data.Body, lat, params, sizeIdx);
            }
            const code = err.toString().split(':')[0];
            if (code === 'NoSuchKey') {
                return callback(null, null, lat, params, sizeIdx);
            }
            stderr.write(`get ${key} in ${bucketName} NOK: `);
            stderr.write(`${err.code} ${err.message}\n`);
            return callback(err);
        });
    }

    deleteObject(bucketName, key, callback, sizeIdx) {
        const object = {
            Bucket: bucketName,
            Key: key,
        };
        const begin = process.hrtime();
        this.s3.deleteObject(object, err => {
            const end = process.hrtime(begin);
            const lat = end[0] * 1e3 + end[1] / 1e6;
            if (!err) {
                return callback(null, lat, sizeIdx);
            }
            const code = err.toString().split(':')[0];
            if (code === 'NoSuchKey') {
                return callback(null, lat, sizeIdx);
            }
            stderr.write(`delete ${key} in ${bucketName} NOK: `);
            stderr.write(`${err.code} ${err.message}\n`);
            return callback(err);
        });
    }

    isCorrectObject(src, data) {
        return (Buffer.compare(data, src) === 0);
    }

    /* get min value of 2D array */
    getMinValue(arr) {
        let arr1D = [];
        this.currActions.forEach(idx => {
            arr1D = arr1D.concat(arr[idx]);
        });
        return Math.min.apply(Math, arr1D);
    }

    updateStats(idx, time) {
        let lat = time / this.nProcesses;
        this.latSum[idx][this.currSizeIdx] += lat;
        this.latSumSq[idx][this.currSizeIdx] += lat * lat;
        this.nBytes[idx][this.currSizeIdx] += this.size;
        this.nSuccesses[idx][this.currSizeIdx]++;
        if (lat < this.latMin[idx][this.currSizeIdx]) {
            this.latMin[idx][this.currSizeIdx] = lat;
        }
        if (lat > this.latMax[idx][this.currSizeIdx]) {
            this.latMax[idx][this.currSizeIdx] = lat;
        }
        lat = Math.floor(lat / this.step);
        if (lat > this.samplesNb) {
            lat = this.samplesNb - 1;
        }
        this.pdf[idx][this.currSizeIdx][lat]++;
    }

    updateStatsFinal(idx) {
        const maxLatThread = Math.max.apply(Math.max, this.latThread[idx]);
        const coef = maxLatThread / this.latSum[idx][this.currSizeIdx];
        if (coef < 1) {
            // update this.pdf
            this.pdf[idx][this.currSizeIdx].forEach((frac, lat) => {
                if (frac > 0) {
                    const newLat = Math.floor(lat * coef);
                    this.pdf[idx][this.currSizeIdx][newLat] += frac;
                    this.pdf[idx][this.currSizeIdx][lat] = 0;
                }
            });
            this.latMin[idx][this.currSizeIdx] *= coef;
            this.latMax[idx][this.currSizeIdx] *= coef;
            const nSuccesses = this.nSuccesses[idx][this.currSizeIdx];
            const latMu = maxLatThread / nSuccesses;
            const latSigma = Math.sqrt(this.latSumSq[idx][this.currSizeIdx] /
                            nSuccesses - latMu * latMu) * coef;
            stderr.write(`${toFixedLength('Final', 12)}`);
            stderr.write(`${toFixedLength(this.nThreads, 2)}  `);
            stderr.write(`${toFixedLength(requests[idx], 6)} `);
            stderr.write(`${toFixedLength(this.size, 8)} `);
            stderr.write(`${toFixedLength(nSuccesses, 6)} `);
            stderr.write(`${toFixedLength(' ', 4)} `);
            stderr.write(`${toFixedLength(' ', 8)} `);
            stderr.write(`${toFixedLength(' ', 8)} `);
            stderr.write(`${toFixedLength(latMu.toFixed(3), 8)} `);
            stderr.write(`${toFixedLength(latSigma.toFixed(3), 8)}\n`);
            const valuesToPlot =
                [nSuccesses, latMu.toFixed(3), latSigma.toFixed(5),
                    this.nThreads.toFixed(3)];
            this.dataToPlot[idx][this.currSizeIdx].push(valuesToPlot);
        }
    }

    finalizePdfCdf() {
        /* normalize pdf, then compute cdf */
        this.pdf.forEach((pdfPerReq, idxA) => {
            pdfPerReq.forEach((pdf, idxB) => {
                const sum = pdf.reduce((a, b) => a + b, 0);
                if (sum > 0) {
                    pdf.forEach((val, idx) => {
                        pdf[idx] = val / sum; // eslint-disable-line
                    });
                    /* compute cdf from pdf */
                    pdf.reduce((a, b, idx) => {
                        this.cdf[idxA][idxB][idx] = a + b;
                        return this.cdf[idxA][idxB][idx];
                    }, 0);
                }
            });
        });
    }

    createBuckets(cb) {
        if (cluster.isMaster && this.nWorkers > 0) {
            cb(); return;
        }
        const bucketName = `${this.bucketPrefix}${this.createdBucketsNb}`;
        stderr.write(`creating bucket ${bucketName}..`);
        this.createBucket(bucketName, err => {
            if (err) {
                cb(`error creating bucket ${bucketName}: ${err}\n`);
                return;
            }
            stderr.write(`done\n`);
            this.buckets.push(bucketName);
            this.createdBucketsNb += 1;
            if (this.createdBucketsNb === this.nBuckets) {
                cb(); return;
            }
            this.createBuckets(cb);
            return;
        });
    }

    cleanBucket(bucketName, cb) {
        this.listObject(bucketName, (err, value) => {
            if (err) {
                cb(err); return;
            }
            if (value.Contents.length === 0) {
                cb(); return;
            }
            let count = 0;
            value.Contents.forEach(obj => {
                this.deleteObject(bucketName, obj.Key, err => {
                    if (err) {
                        cb(err); return;
                    }
                    count += 1;
                    if (count === value.Contents.length) {
                        this.cleanBucket(bucketName, cb);
                        return;
                    }
                });
            });
        }, 100);
    }

    clearDataSimul(cb) {
        stderr.write('clearing databases..');
        let count = 0;
        this.buckets.forEach(bucketName => {
            this.cleanBucket(bucketName, err => {
                if (err) {
                    return cb(err);
                }
                stderr.write(`deleting bucket ${bucketName}..\n`);
                return this.deleteBucket(bucketName, err => {
                    if (err) {
                        cb(err);
                        return;
                    }
                    stderr.write(`bucket ${bucketName} is deleted\n`);
                    count += 1;
                    if (count === this.buckets.length) {
                        this.buckets = [];
                        this.createdBucketsNb = 0;
                        stderr.write(`clear done\n`);
                        cb();
                        return;
                    }
                });
            });
        });
    }

    doSimul(cb) {
        if (this.actionFlag[PUT_OBJ] || this.actionFlag[GET_OBJ] ||
            this.actionFlag[DEL_OBJ] || this.actionFlag[COM_OBJ] ||
            this.actionFlag[LST_OBJ]) {
            this.startSimul = process.hrtime();
            this.latThread = requests.map(() =>
                createNewArray(this.nThreads, 0)
            );
            if (cluster.isMaster) {
                for (let i = 0; i < this.nWorkers; i++) {
                    cluster.fork();
                }
                if (this.nWorkers === 0) {
                    for (let idx = 0; idx < this.nThreads; idx++) {
                        this.threads++;
                        if (this.simulPolicy === simulMixed) {
                            this.setNextRandomAction.bind(this)();
                        }
                        this.actions[this.actionIdx].bind(this)(cb, idx);
                    }
                }
            } else {
                for (let idx = 0; idx < this.nThreads; idx++) {
                    this.threads++;
                    if (this.simulPolicy === simulMixed) {
                        this.setNextRandomAction.bind(this)();
                    }
                    this.actions[this.actionIdx].bind(this)(cb, idx);
                }
            }
        } else {
            cb();
        }
    }

    setNextRandomAction() {
        this.currSizeIdx = Math.floor(Math.random() * this.sizes.length);
        this.actionIdx = this.currActions[Math.floor(Math.random() *
                                            this.actionsNb)];
        this.size = this.sizes[this.currSizeIdx];
        this.value = this.values[this.currSizeIdx];
    }

    doNextAction(reqIdx, cb, threadIdx) {
        /* if current data size is the last one
         *  - current request is done, disable it
         *  - go next request
         *      if current request is the last one, do next `threadsNb`
         * otherwise, go next data size
         */
        function doNextDataSize() {
            if (this.currSizeIdx === this.sizes.length - 1) {
                this.actionFlag[reqIdx] = false;
                this.currSizeIdx = 0;
                /* if current request is the last one -> simul is done */
                if (this.actionIdx === this.actions.length - 1) {
                    if (reqIdx === COM_OBJ) {
                        for (let idx = PUT_OBJ; idx <= DEL_OBJ; idx++) {
                            this.printStats(idx);
                            this.updateStatsFinal(idx);
                            this.resetStats(idx);
                        }
                    }
                    return false; // will call next threadsNb
                }
                this.actionIdx++;
            } else {
                this.currSizeIdx++;
            }
            return true; // will do next action/datasize
        }

        /* if current thread number is the last one
         *  - return to call callback to finish
         * otherwise, go next threads number. It then requires reset actions
         *    and data sizes indices.
         */
        function doNextThread() {
            this.updateThreadStats();
            if (this.currThreadIdx === this.rThreads.length - 1) {
                this.currThreadIdx = 0;
                this.nThreads = this.rThreads[0];
                return false; // will call cb
            }
            this.currThreadIdx++;
            this.nThreads = this.rThreads[this.currThreadIdx];

            //  for simulEach only, reset data size and action indices
            if (this.simulPolicy === simulEach) {
                this.currSizeIdx = 0;
                this.actionIdx = 0;
                this.setActions(this.currActions);
            }

            return true; // will do next thread
        }

        /* if a request with a data size simulation runned for given 'threshold'
         *      number of iterations -> prepare for next simulation
         * otherwise, do next action
         */
        if (this.count >= this.threshold) {
            this.threads--;
            if (this.threads === 0) {
                if (this.simulPolicy === simulMixed) {
                    for (let idx = 0; idx < this.currActions.length; idx++) {
                        this.printStats(idx);
                        this.updateStatsFinal(idx);
                        this.resetStats(idx);
                    }
                    if (!doNextThread.bind(this)()) {
                        cb();
                        return;
                    }
                } else {
                    this.printStats(reqIdx);
                    this.updateStatsFinal(reqIdx);
                    this.resetStats(reqIdx);
                    /* decide for next data size */
                    if (!doNextDataSize.bind(this)()) {
                        /* decide for next nThreads */
                        if (!doNextThread.bind(this)()) {
                            cb();
                            return;
                        }
                    }
                }
                this.size = this.sizes[this.currSizeIdx];
                this.value = this.values[this.currSizeIdx];
                this.doSimul.bind(this)(cb);
            }
            return;
        }
        /* number of operations is not enough -> continue */
        if (this.simulPolicy === simulMixed) {
            this.currSizeIdx = Math.floor(Math.random() * this.sizes.length);
            this.actionIdx = this.currActions[Math.floor(Math.random() *
                                                this.actionsNb)];
            this.size = this.sizes[this.currSizeIdx];
            this.value = this.values[this.currSizeIdx];
        }
        this.actions[this.actionIdx].bind(this)(cb, threadIdx);
    }

    put(cb, threadIdx) {
        this.count++;
        const data = {
            key: `key_S${this.size}_T${this.nThreads}_C${this.count}`,
            data: Buffer.from(this.value),
            sizeIdx: this.currSizeIdx,
        };
        const bucketName =
            this.buckets[Math.floor(Math.random() * this.nBuckets)];

        function putCb(err, val, storedKey, time) {
            if (err) {
                this.nFailures[PUT_OBJ][this.currSizeIdx]++;
                stderr.write(`put error: ${val} ${process.hrtime()}\n`);
                return cb(err);
            }
            this.latThread[PUT_OBJ][threadIdx] += time;
            this.storedKeys[storedKey.SizeIdx].push(storedKey);
            this.updateStats.bind(this)(PUT_OBJ, time);
            if (this.nSuccesses[PUT_OBJ][storedKey.SizeIdx] %
                    this.freqsToShow === 0) {
                this.printStats(PUT_OBJ);
            }
            return this.doNextAction(PUT_OBJ, cb, threadIdx);
        }
        this.putObject(bucketName, data, putCb.bind(this));
    }

    get(cb, threadIdx) {
        this.count++;
        if (this.simulPolicy === simulMixed) {
            if (this.storedKeys[this.currSizeIdx].length === 0) {
                this.count--;
                this.setNextRandomAction.bind(this)();
                this.actions[this.actionIdx].bind(this)(cb, threadIdx);
                return;
            }
        }
        const storedKey = this.storedKeys[this.currSizeIdx]
                            [Math.floor(Math.random() *
                                this.storedKeys[this.currSizeIdx].length)];
        let key;
        let bucketName;
        if (storedKey) {
            key = storedKey.Key;
            bucketName = storedKey.Bucket;
        } else {
            key = 'no_key';
            bucketName =
                this.buckets[Math.floor(Math.random() * this.nBuckets)];
        }

        function getCb(err, data, time, params, sizeIdx) {
            if (err) {
                this.nFailures[GET_OBJ][sizeIdx]++;
                stderr.write(`get error: ${err}\n`);
                return cb(err);
            }
            this.latThread[GET_OBJ][threadIdx] += time;
            this.updateStats(GET_OBJ, time);
            if (this.nSuccesses[GET_OBJ][sizeIdx] %
                    this.freqsToShow === 0) {
                this.printStats(GET_OBJ);
            }
            return this.doNextAction(GET_OBJ, cb, threadIdx);
        }
        this.getObject(bucketName, key, getCb.bind(this), this.currSizeIdx);
    }

    del(cb, threadIdx) {
        this.count++;
        if (this.simulPolicy === simulMixed) {
            if (this.storedKeys[this.currSizeIdx].length === 0) {
                this.count--;
                this.setNextRandomAction.bind(this)();
                this.actions[this.actionIdx].bind(this)(cb, threadIdx);
                return;
            }
        }
        const storedKey = this.storedKeys[this.currSizeIdx].pop();

        let key;
        let bucketName;
        if (storedKey) {
            key = storedKey.Key;
            bucketName = storedKey.Bucket;
        } else {
            key = 'no_key';
            bucketName =
                this.buckets[Math.floor(Math.random() * this.nBuckets)];
        }

        function delCb(err, time, sizeIdx) {
            if (err) {
                this.nFailures[DEL_OBJ][sizeIdx]++;
                stderr.write(`delete error: ${err}\n`);
                return cb(err);
            }
            this.latThread[DEL_OBJ][threadIdx] += time;
            this.updateStats(DEL_OBJ, time);
            if (this.nSuccesses[DEL_OBJ][sizeIdx] %
                    this.freqsToShow === 0) {
                this.printStats(DEL_OBJ);
            }
            return this.doNextAction(DEL_OBJ, cb, threadIdx);
        }
        this.deleteObject(bucketName, key, delCb.bind(this), this.currSizeIdx);
    }

    list(cb, threadIdx) {
        this.count++;
        if (this.simulPolicy === simulMixed) {
            if (this.storedKeys[this.currSizeIdx].length === 0) {
                this.count--;
                this.setNextRandomAction.bind(this)();
                this.actions[this.actionIdx].bind(this)(cb, threadIdx);
                return;
            }
        }
        const bucketName =
            this.buckets[Math.floor(Math.random() * this.nBuckets)];
        function listCb(err, value, time) {
            if (err) {
                this.nFailures[LST_OBJ][this.currSizeIdx]++;
                stderr.write(`get error: ${err}\n`);
                return cb(err);
            }
            this.latThread[LST_OBJ][threadIdx] += time;
            this.updateStats(LST_OBJ, time);
            if (this.nSuccesses[LST_OBJ][this.currSizeIdx] %
                    this.freqsToShow === 0) {
                this.printStats(LST_OBJ);
            }
            return this.doNextAction(LST_OBJ, cb, threadIdx);
        }
        const prefix = `key_S${this.size}_T${this.nThreads}`;
        // const prefix = `key_S${this.size}_T10`;
        this.listAllObjects(bucketName, listCb.bind(this), prefix, null, 0, 0);
    }

    /* put->get->del object */
    comb(cb, threadIdx) {
        this.count++;
        const data = {
            key: `key_S${this.size}_T${this.nThreads}_C${this.count}`,
            data: Buffer.from(this.value),
            sizeIdx: this.currSizeIdx,
        };
        const bucketName =
            this.buckets[Math.floor(Math.random() * this.nBuckets)];

        let actionTime = 0;

        function delCb(err, dTime, sizeIdx) {
            if (err) {
                this.nFailures[COM_OBJ][sizeIdx]++;
                stderr.write(`comb error after del\n`);
                return cb(err);
            }
            actionTime += dTime;
            this.latThread[DEL_OBJ][threadIdx] += dTime;
            this.latThread[COM_OBJ][threadIdx] += actionTime;
            this.updateStats(DEL_OBJ, dTime);
            this.updateStats(COM_OBJ, actionTime);
            if (this.nSuccesses[COM_OBJ][sizeIdx] %
                    this.freqsToShow === 0) {
                this.printStats(DEL_OBJ);
                this.printStats(COM_OBJ);
            }
            return this.doNextAction(COM_OBJ, cb, threadIdx);
        }

        function getCb(err, data, gTime, params, sizeIdx) {
            if (err) {
                this.nFailures[COM_OBJ][sizeIdx]++;
                stderr.write(`comb error after get: ${err}\n`);
                return cb(err);
            }
            actionTime += gTime;
            this.latThread[GET_OBJ][threadIdx] += gTime;
            this.updateStats(GET_OBJ, gTime);
            if (this.nSuccesses[GET_OBJ][sizeIdx] %
                    this.freqsToShow === 0) {
                this.printStats(GET_OBJ);
            }
            return this.deleteObject(params.Bucket, params.Key,
                                delCb.bind(this), sizeIdx);
        }

        function putCb(err, val, storedKey, pTime) {
            if (err) {
                this.nFailures[COM_OBJ][storedKey.SizeIdx]++;
                stderr.write(`comb error after put: ${err}\n`);
                return cb(err);
            }
            actionTime += pTime;
            this.latThread[PUT_OBJ][threadIdx] += pTime;
            this.updateStats(PUT_OBJ, pTime);
            if (this.nSuccesses[PUT_OBJ][storedKey.SizeIdx] %
                    this.freqsToShow === 0) {
                this.printStats(PUT_OBJ);
            }
            return this.getObject(storedKey.Bucket, storedKey.Key,
                                    getCb.bind(this), storedKey.SizeIdx);
        }

        this.putObject(bucketName, data, putCb.bind(this));
    }
}

module.exports = S3Blaster;
S3Blaster.requests = {
    putObj: PUT_OBJ,
    getObj: GET_OBJ,
    delObj: DEL_OBJ,
    comObj: COM_OBJ,
    lstObj: LST_OBJ,
};

S3Blaster.requestsString = {
    reqs: requests,
};

S3Blaster.simulPolicy = {
    each: simulEach,
    mixed: simulMixed,
};

S3Blaster.statsFolder = {
    path: statsFolder,
};

/* ==== For Live Test running directly from this file ==== */
function listValues(val) {
    return val.split(',');
}

function helpS3blaster() {
    stderr.write(`Run directly s3blaster test via mocha with arguments:\n`);
    stderr.write(`(o)Host:\n`);
    stderr.write(`  -H, --host: host adresse\n`);
    stderr.write(`  -P, --port: port\n`);
    stderr.write(`(o)Request type:\n`);
    stderr.write(`  -x, --put : put object\n`);
    stderr.write(`  -y, --get : get object\n`);
    stderr.write(`  -z, --delete : del object\n`);
    stderr.write(`  -l, --list : list objects\n`);
    stderr.write(`  -c, --combine : combined operation put->get->delete\n`);
    stderr.write(`(o)Order of requests:\n`);
    stderr.write(`  -o, --order-reqs: order of requests\n`);
    stderr.write(`(o)Simulation policy:\n`);
    stderr.write('  -m, --simul: type of simulation, ');
    stderr.write(`either 'e' for simulEach, 'm' for simulMixed\n`);
    stderr.write(`(o)Number of operations per one set of parameters:\n`);
    stderr.write(`  -n, --n-ops: Number of operations\n`);
    stderr.write(`(o)Bucket:\n`);
    stderr.write(`  -B, --bucket-prefix: prefix for bucket name\n`);
    stderr.write(`  -u, --n-buckets: number of buckets\n`);
    stderr.write(`(o)Data sizes:\n`);
    stderr.write(`  -s, --sizes-set <items>: data sizes, separated by ','\n`);
    stderr.write('  -r, --sizes-arr <a>:<b>:<c>: range of data sizes, from ');
    stderr.write('`a` to `c` with step `b`. Its priority is less than ');
    stderr.write(`--sizes-list\n`);
    stderr.write('  -u, --unit: data size unit, ');
    stderr.write(`either '1' for bytes, 'k' for KB, 'm' for MB\n`);
    stderr.write(`(o)Number of threads:\n`);
    stderr.write('  -N, --r-threads <a>:<b>:<c>: ');
    stderr.write(`Threads range from 'a' to 'c' with step 'b'\n`);
    stderr.write(`(o)Graphs to plot:\n`);
    stderr.write('  -g, --graphs <items>: `a` for avg-std, `p` for pdf-cdf, ');
    stderr.write(`'s' for data sizes, 't' for threads\n`);
    stderr.write(`(o)Suffix for output files:\n`);
    stderr.write(`  -f, --output: suffix for output files\n`);
    stderr.write(`(o)Clustering:\n`);
    stderr.write(`  -w, --n-workers: workers number\n`);
}

function mochaTest() {
    const Plotter = require('./plotter');

    /* Available graph to be plotted:
    graphs = {
       avgStd: average and standard-deviabtion graph will be plotted
       pdfCdf: estimated pdf/cdf graphs will be plotted
       statSize: latency vs. sizes graph will be plotted
       thread: latency vs. number of threads graph will be plotted
    };
    */
    const graphs = Plotter.graphs;
    const KB = 1024;
    const MB = KB * KB;

    describe('Measure performance', function Perf() {
        this.timeout(0);
        commander.version('0.0.1')
        .option('-x, --put', 'Put object')
        .option('-y, --get', 'Get object')
        .option('-z, --delete', 'Delete object')
        .option('-l, --list', 'List objects')
        .option('-c, --combine', 'Put->Get->Delete object')
        .option('-g, --graphs <items>', 'Graphs to plot', listValues)
        .option('-s, --sizes-set <items>', 'Set of data sizes', listValues)
        .option('-r, --sizes-arr <items>', 'Range of data sizes', range)
        .option('-u, --unit [unit]', 'Data size unit')
        .option('-f, --output [output]', 'Suffix for output files')
        .option('-m, --simul [simul]', 'Type of simulation')
        .option('-d, --distr <items>', 'Step, number of samples', listValues)
        .option('-o, --order-reqs <items>', 'Order of requests', listValues)
        .option('-h, --helps3')
        .parse(process.argv);
        if (commander.helps3) {
            helpS3blaster();
            return;
        }

        let _simulPolicy;
        if (commander.simul) {
            if (commander.simul === 'e') {
                _simulPolicy = simulEach;
            } else if (commander.simul === 'm') {
                _simulPolicy = simulMixed;
            } else {
                _simulPolicy = simulEach;
                stderr.write('wrong arg for `simulPolicy`. ');
                stderr.write(`Set it as simulEach\n`);
            }
        }

        const _suffix = commander.output || 'LiveTest';
        const _prefSufName = [`${defaultFileName}${_suffix}`, ''];
        const _reqsToTest = [];
        if (commander.put) {
            _reqsToTest.push(PUT_OBJ);
        }
        if (commander.list) {
            _reqsToTest.push(LST_OBJ);
        }
        if (commander.get) {
            _reqsToTest.push(GET_OBJ);
        }
        if (commander.delete) {
            _reqsToTest.push(DEL_OBJ);
        }
        if (commander.combine) {
            _reqsToTest.push(PUT_OBJ, GET_OBJ, DEL_OBJ, COM_OBJ);
        }
        if (_reqsToTest.length === 0) {
            _reqsToTest.push(PUT_OBJ, LST_OBJ, GET_OBJ, DEL_OBJ);
        }

        // ordering list of requests
        const orderedReqsToTest = [];
        let order = ['x', 'l', 'y', 'z', 'c'];
        if (commander.orderReqs) {
            order = commander.orderReqs.slice();
        }
        order.forEach(req => {
            if (req === 'x' && commander.put) {
                orderedReqsToTest.push(PUT_OBJ);
            }
            if (req === 'l' && commander.list) {
                orderedReqsToTest.push(LST_OBJ);
            }
            if (req === 'y' && commander.get) {
                orderedReqsToTest.push(GET_OBJ);
            }
            if (req === 'z' && commander.delete) {
                orderedReqsToTest.push(DEL_OBJ);
            }
            if (req === 'c' && commander.combine) {
                orderedReqsToTest.push(COM_OBJ);
            }
        });

        const _graphsToPlot = [];
        if (commander.graphs) {
            if (commander.graphs.indexOf('a') > -1) {
                _graphsToPlot.push(graphs.avgStd);
            }
            if (commander.graphs.indexOf('p') > -1) {
                _graphsToPlot.push(graphs.pdfCdf);
            }
            if (commander.graphs.indexOf('s') > -1) {
                _graphsToPlot.push(graphs.statSize);
            }
            if (commander.graphs.indexOf('t') > -1) {
                _graphsToPlot.push(graphs.thread);
            }
        }

        let unit = 1;
        if (commander.unit) {
            switch (commander.unit) {
            case '1': unit = 1; break;
            case 'k': unit = KB; break;
            case 'm': unit = MB; break;
            default: unit = 1; break;
            }
        }
        let _sizes = [KB, MB];
        if (commander.sizesSet) {
            _sizes = commander.sizesSet.map(size => unit * parseInt(size, 10));
        } else {
            if (commander.sizesArr) {
                _sizes = commander.sizesArr.map(size => unit * size);
            }
        }

        let _distrFuncParams = [0.5, 500];
        if (commander.distr) {
            _distrFuncParams = commander.distr.map(Number);
        }

        const host = 'nodea.ringr2.devsca.com';
        const port = 80;
        const blaster = new S3Blaster(host, port);
        let plotter = undefined;
        before(done => {
            blaster.setParams({
                prefSufName: _prefSufName,
                reqsToTest: _reqsToTest,
                simulPolicy: _simulPolicy,
                nOps: -1,
                freqsToShow: -1,
                sizes: _sizes,
                arrThreads: -1,
                distrFuncParams: _distrFuncParams,
            });
            blaster.init((err, arrDataFiles) => {
                if (err) {
                    return done(err);
                }
                plotter = new Plotter(arrDataFiles, _prefSufName[0],
                                        _graphsToPlot);
                return done();
            });
        });

        it('run test', done => {
            blaster.setActions(orderedReqsToTest);
            blaster.doSimul(done);
        });

        afterEach(done => {
            blaster.updateDataFiles(done);
        });

        after(done => {
            blaster.updateStatsFiles(err => {
                if (err) {
                    return done(err);
                }
                return plotter.plotData(err => {
                    if (err) {
                        process.stdout.write(err);
                    }
                    blaster.clearDataSimul(err => {
                        if (err) {
                            return done(err);
                        }
                        return done();
                    });
                });
            });
        });
    });
}

if (calledFileName === 's3blaster') {
    mochaTest();
}
