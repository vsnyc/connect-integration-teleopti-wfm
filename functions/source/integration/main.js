const AWS = require('aws-sdk');
const util = require('util');
const Promise = require('bluebird');
const conf = Promise.promisifyAll(require('./configHelper'));
const s3 = new AWS.S3();
const sftpHelper = require('./sftpHelper');
const json2csv = require('./jsontocsv');
const sqs = new AWS.SQS();

var objIsCSV = true;

exports.handle = async (event, context, callback) => {
    console.log(JSON.stringify(event));
    console.log(JSON.stringify(context));

    var records = event.Records;
    for (let index = 0; index < records.length; index++) {

        // Read options from the event parameter.
        //console.log("Reading options from event:\n", util.inspect(event, {depth: 5}));


        var eventJson = JSON.parse(records[index].body);
        console.log(eventJson.Records);

        var bodyRecords = eventJson.Records;


        for (let indexJ = 0; indexJ < bodyRecords.length; indexJ++) {

            var srcBucket = bodyRecords[indexJ].s3.bucket.name;
            // Object key may have spaces or unicode non-ASCII characters.
            var srcKey = decodeURIComponent(bodyRecords[indexJ].s3.object.key.replace(/\+/g, " "));

            try {
                const params = {
                    Bucket: srcBucket,
                    Key: srcKey
                };
                var s3Obj = await s3.getObject(params).promise();
                var config = await conf.getConfigAsync(context);
                var sftpConfig = await exports.getSftpConfig(config);

            } catch (error) {
                console.log(error);
    //            return;
            }

            console.info("srcKey: " + srcKey);
            var fullS3Path = srcBucket + '/' + srcKey;
            console.info("Object path: " + fullS3Path + " | config s3 Loc: " + config["s3Location"]);
            var newObjectS3Path = exports.getFilePathArray(fullS3Path);

            let objectData = s3Obj.Body.toString('utf-8');

            console.log(objectData);

            // Do not process Calabrio_ServiceHistorical or Calabrio_AgentProductivity CSV reports and move on//
            if (srcKey.match(/Calabrio/i)) {
                console.info("Key " + srcKey + " is a Calabrio Report. Stop processing and retrieve next file");
                //          return;
            }

            // Do not process WAV files and move on
            if (srcKey.match(/\.wav$/i)) {
                console.info("Key " + srcKey + " is a wav file. Stop processing and retrieve next file");
    //            return;
            }

            if (!objectData.Metadata || objectData.Metadata.synched !== "true") {
                //console.info("New Object path: " + newObjectS3Path);
                var configKeys = Object.keys(config)//.filter(function(key) {
                if (configKeys.length === 0) console.warn("No configured SFTP destination for " + fullS3Path);
                var s3Location = config["s3Location"];

                try {
                    if (s3Location) {
                        console.info("Configkeys: " + Object.keys(config));
                        var configS3Path = exports.getFilePathArray(s3Location);
                    }
                } catch (err) {
                    console.info("Error caught in exports.getFilePathArray(s3Location): " + err);
                }

                var bodydata = objectData;

                if (srcKey.match(/\.csv$/) === null) {
                    var msg = "Key " + srcKey + " is not a csv file, attempting CTR conversion";
                    objIsCSV = false;
                    console.log(msg);
                } else {
                    objIsCSV = true;
                }

                if (!objIsCSV) {
                    try {
                        bodydata = json2csv.jsonconvert(objectData);
                        console.info("Returned from json2csv.jsonconvert successfully");
                    } catch (err) {
                        console.info("Error in json2csv.jsonconvert: " + err);
                        console.info("json2csv.jsonconvert(objectData): " + objectData);
    //                    return err;
                    }
                }

            }
            console.info("s3Location: " + s3Location);
            try {
                var configS3Path = exports.getFilePathArray(config["s3Location"]);
            } catch (err) {
                console.info("Error in getFilePathArray: " + err);
            }
            try {
                var sftpDirPath = exports.getFilePathArray(config["sftpLocation"]);
            } catch (err) {
                console.info("Error in getFilePathArray: " + err);
            }
            console.info("configS3Path: " + configS3Path + " | sftpDirPath:" + sftpDirPath);

            let sftpObj = sftpHelper.withSftpClient(sftpConfig, function (sftp) {
                console.info("Returned from sftpHelper.withSftpClient");
                var sftpFileName = sftpDirPath.concat(newObjectS3Path[newObjectS3Path.length - 1].replace(/:/g, '_')).join('/');
                console.info("sftpFileName");
                if (!objIsCSV) {
                    sftpFileName += ".csv";
                }
                console.log("Calling sftpHelper.writeFile");
                return sftpHelper.writeFile(
                    sftp,
                    sftpFileName,
                    bodydata
                )
                    .then(function () {
                        console.info("...done");
                        console.info("[" + sftpFileName + "]: Moved 1 files from S3 to SFTP");
                        return sftpFileName;
                    })
                    .catch(function (err) {
                        console.log(err);
                    });
            });

            try {
                await sftpObj;
            } catch (error) {
                console.log(error);
    //            return;
            }
        }
    }
};

exports.getFilePathArray = function (filePath) {
    return (filePath || '').split('/').filter(function (s) {
        return s ? true : false
    });
};

exports.getSftpConfig = function (config) {
    return Promise.try(function () {
        if (!config["host"]) throw new Error("SFTP config not found");
        console.info("Host found: " + config["host"]);
        var sftpconfig = {
            "host": config["host"],
            "port": config["port"],
            "username": config["username"],
            "password": config["password"],
        };
        if (config["s3PrivateKey"]) {
            var bucketDelimiterLocation = config.sftpConfig.s3PrivateKey.indexOf("/");

            var getParams = {
                Bucket: config.sftpConfig.s3PrivateKey.substr(0, bucketDelimiterLocation),
                Key: config.sftpConfig.s3PrivateKey.substr(bucketDelimiterLocation + 1)
            };

            var s3obj = s3.getObject(getParams, function (err, data) {
                // Handle any error and exit
                if (err) {
                    console.info("getSftpConfig: Error caught in s3.getObject: " + err);
                    return err;
                }

                let objectData = data.Body.toString('utf-8');
                sftpconfig.privateKey = objectData;
                //delete config.s3PrivateKey;
                return sftpconfig;
            });
        } else {
            console.info("Returning sftpconfig");
            return sftpconfig;
        }
    });
};

function flatten(arr) {
    return arr.reduce(function (a, b) {
        if (Array.isArray(b)) {
            return a.concat(flatten(b));
        } else if (b) {
            a.push(b);
            return a;
        } else {
            return a;
        }
    }, []);
}
