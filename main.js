//Trying to avoid any npm installs or anything that takes extra time...
const https = require('https'),
    zlib = require('zlib'),
    fs = require('fs'),
    env = process.env;

function fail(message, exitCode = 1) {
    console.log(`::error::${message}`);
    process.exit(1);
}

function request(method, path, data, callback) {

    try {
        if (data) {
            data = JSON.stringify(data);
        }
        const options = {
            hostname: 'api.github.com',
            port: 443,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data ? data.length : 0,
                'Accept-Encoding': 'gzip',
                'Authorization': `token ${env.INPUT_TOKEN}`,
                'User-Agent': 'GitHub Action - development'
            }
        }
        const req = https.request(options, res => {

            let chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                let buffer = Buffer.concat(chunks);
                if (res.headers['content-encoding'] === 'gzip') {
                    zlib.gunzip(buffer, (err, decoded) => {
                        if (err) {
                            callback(err);
                        } else {
                            callback(null, res.statusCode, decoded && JSON.parse(decoded));
                        }
                    });
                } else {
                    callback(null, res.statusCode, buffer.length > 0 ? JSON.parse(buffer) : null);
                }
            });

            req.on('error', err => callback(err));
        });

        if (data) {
            req.write(data);
        }
        req.end();
    } catch (err) {
        callback(err);
    }
}

function main() {

    const path = 'BUILD_NUMBER/BUILD_NUMBER';
    const prefix = env.INPUT_PREFIX ? `${env.INPUT_PREFIX}-` : '';
    const dailybuild = env.INPUT_DAILYBUILD ? true : false;

    //See if we've already generated the build number and are in later steps...
    if (fs.existsSync(path)) {
        let buildNumber = fs.readFileSync(path);
        console.log(`Build number already generated in earlier jobs, using build number ${buildNumber}...`);
        //Setting the output and a environment variable to new build number...
        fs.writeFileSync(process.env.GITHUB_OUTPUT, `build_number=${buildNumber}`);
        fs.writeFileSync(process.env.GITHUB_ENV, `BUILD_NUMBER=${buildNumber}`);
        return;
    }

    //Some sanity checking:
    for (let varName of ['INPUT_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_SHA']) {
        if (!env[varName]) {
            fail(`ERROR: Environment variable ${varName} is not defined.`);
        }
    }

    request('GET', `/repos/${env.GITHUB_REPOSITORY}/git/refs/tags/${prefix}build-number-`, null, (err, status, result) => {

        let nextBuildNumber, nrTags;

        if (status === 404) {
            console.log('No build-number ref available, starting at 1.');
            nextBuildNumber = 1;
            nrTags = [];
        } else if (status === 200) {
            if (dailybuild) {
                const dailyRegexString = `/${prefix}build-number-(\\d{8})\\.(\\d+)$`;
                const dailyRegex = new RegExp(dailyRegexString);
                nrTags = result.filter(d => d.ref.match(dailyRegex));

                const MAX_OLD_NUMBERS = 5; //One or two ref deletes might fail, but if we have lots then there's something wrong!
                if (nrTags.length > MAX_OLD_NUMBERS) {
                    fail(`ERROR: Too many ${prefix}build-number- refs in repository, found ${nrTags.length}, expected only 1. Check your tags!`);
                }

                //Existing build numbers:
                const tags = nrTags.map(t => t.ref.match(/-(\d{8}\.\d+)$/)[1]);

                const buildObjects = tags.map(tag => {
                    const [buildDate, buildRev] = tag.split('.');
                    return {
                        buildNumber: tag,
                        buildDate: buildDate,
                        buildRev: parseInt(buildRev, 10)
                    };
                }).sort((a, b) => {
                    if (a.buildDate === b.buildDate) {
                        return b.buildRev - a.buildRev; // Sort by buildRev in descending order
                    }
                    return b.buildDate.localeCompare(a.buildDate); // Sort by buildDate in descending order
                });

                const latestBuild = buildObjects[0];
                const currentDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
                const newRev = currentDate == latestBuild?.buildDate ? latestBuild?.buildRev + 1 : 1;
                const newBuildObject = {
                    buildNumber: `${currentDate}.${newRev}`,
                    buildDate: currentDate,
                    buildRev: newRev
                };

                console.log(`Last build nr was ${latestBuild?.buildNumber}.`);

                nextBuildNumber = newBuildObject.buildNumber;
                console.log(`Updating build counter to ${nextBuildNumber}...`);
            } else {
                const regexString = `/${prefix}build-number-(\\d+)$`;
                const regex = new RegExp(regexString);
                nrTags = result.filter(d => d.ref.match(regex));

                const MAX_OLD_NUMBERS = 5; //One or two ref deletes might fail, but if we have lots then there's something wrong!
                if (nrTags.length > MAX_OLD_NUMBERS) {
                    fail(`ERROR: Too many ${prefix}build-number- refs in repository, found ${nrTags.length}, expected only 1. Check your tags!`);
                }

                //Existing build numbers:
                let nrs = nrTags.map(t => parseInt(t.ref.match(/-(\d+)$/)[1]));

                let currentBuildNumber = Math.max(...nrs);
                console.log(`Last build nr was ${currentBuildNumber}.`);

                nextBuildNumber = currentBuildNumber + 1;
                console.log(`Updating build counter to ${nextBuildNumber}...`);
            }
        } else {
            if (err) {
                fail(`Failed to get refs. Error: ${err}, status: ${status}`);
            } else {
                fail(`Getting build-number refs failed with http status ${status}, error: ${JSON.stringify(result)}`);
            }
        }

        let newRefData = {
            ref: `refs/tags/${prefix}build-number-${nextBuildNumber}`,
            sha: env.GITHUB_SHA
        };

        request('POST', `/repos/${env.GITHUB_REPOSITORY}/git/refs`, newRefData, (err, status, result) => {
            if (status !== 201 || err) {
                fail(`Failed to create new build-number ref. Status: ${status}, err: ${err}, result: ${JSON.stringify(result)}`);
            }

            console.log(`Successfully updated build number to ${nextBuildNumber}`);

            //Setting the output and a environment variable to new build number...
            fs.writeFileSync(process.env.GITHUB_OUTPUT, `build_number=${nextBuildNumber}`);
            fs.writeFileSync(process.env.GITHUB_ENV, `BUILD_NUMBER=${nextBuildNumber}`);

            //Save to file so it can be used for next jobs...
            fs.writeFileSync('BUILD_NUMBER', nextBuildNumber.toString());

            //Cleanup
            if (nrTags) {
                console.log(`Deleting ${nrTags.length} older build counters...`);

                for (let nrTag of nrTags) {
                    request('DELETE', `/repos/${env.GITHUB_REPOSITORY}/git/${nrTag.ref}`, null, (err, status, result) => {
                        if (status !== 204 || err) {
                            console.warn(`Failed to delete ref ${nrTag.ref}, status: ${status}, err: ${err}, result: ${JSON.stringify(result)}`);
                        } else {
                            console.log(`Deleted ${nrTag.ref}`);
                        }
                    });
                }
            }

        });
    });
}

main();



