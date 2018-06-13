const fetch = require('node-fetch');
const XMLparser = require('xml2json');
const dateFns = require('date-fns');
const express = require('express');
const ejs = require('ejs');
var schedule = require('node-schedule');

const app = express();
const port = process.env.PORT || "8000";
const webhookKey = process.env.WEBHOOK_URL;

if (!webhookKey) {
    console.warn("No WEBHOOK_URL provided, unable to send IFTTT webhook POST");
}

const response = {
    updatedOn: "",
    bins: {
        garden: {
            isDue: false,
            daysUntilDue: undefined,
            collectionDate: undefined,
            hasBeenPutOut: false // TODO make this work from actual data from bin's location!
        },
        waste: {
            isDue: false,
            daysUntilDue: undefined,
            collectionDate: undefined,
            hasBeenPutOut: false // TODO make this work from actual data from bin's location!
        },
        recycling: {
            isDue: false,
            daysUntilDue: undefined,
            collectionDate: undefined,
            hasBeenPutOut: false // TODO make this work from actual data from bin's location!
        }
    }
}

const binIsDue = collectionISODate => {
    const today = new Date();
    const tomorrow = dateFns.addDays(today, 1);
    const todaysDate = today.toLocaleDateString("en-GB");
    const binCollectionTimeHasPassed = dateFns.isAfter(today, new Date(today.getFullYear(), today.getMonth(), today.getDate(), 21, 11, 0, 0));
    const tomorrowsDate = new Date(tomorrow).toLocaleDateString("en-GB");
    const collectionDate = new Date(collectionISODate).toLocaleDateString("en-GB");

    if (tomorrowsDate === collectionDate) {

        return true;
    }
    if (todaysDate === collectionDate && !binCollectionTimeHasPassed) {
        return true;
    }
    return false;
};

const getCollectionDate = collectionDate => {
    const dateParts = collectionDate.split(" ");
    const dayNumber = dateParts[1].match(/^[0-9]*/);
    const month = dateParts[2]
    const year = dateParts[3];

    const date = new Date(`${month} ${dayNumber}, ${year} 23:00:00`);

    return date.toISOString();
};

const getDaysUntilDue = collectionISODate => {
    const noOfDays = dateFns.distanceInWordsStrict(new Date(), collectionISODate, {unit: "d"});
    if (noOfDays.split(" days")[0] === "1") {
        return "Tomorrow";
    }
    if (noOfDays.split(" days")[0] === "0") {
        return "Today";
    }
    return noOfDays;
}

const formatData = json => {
    const collectionDates = {
        garden: getCollectionDate(json.rss.channel[0].item.title),
        waste: getCollectionDate(json.rss.channel[1].item.title),
        recycling: getCollectionDate(json.rss.channel[2].item.title)
    };

    return {
        garden: {
            isDue: binIsDue(collectionDates.garden),
            daysUntilDue: getDaysUntilDue(collectionDates.garden),
            collectionDate: collectionDates.garden,
            hasBeenPutOut: false // TODO make this work from actual data from bin's location!
        },
        waste: {
            isDue: binIsDue(collectionDates.waste),
            daysUntilDue: getDaysUntilDue(collectionDates.waste),
            collectionDate: collectionDates.waste,
            hasBeenPutOut: false // TODO make this work from actual data from bin's location!
        },
        recycling: {
            isDue: binIsDue(collectionDates.recycling),
            daysUntilDue: getDaysUntilDue(collectionDates.recycling),
            collectionDate: collectionDates.recycling,
            hasBeenPutOut: false // TODO make this work from actual data from bin's location!
        }
    }
};

const buildResponseData = async () => {
    const xml = await fetch("http://www.newport.gov.uk/model/ncc/services/myNewportService.cfc?method=getPropertyData&uprn=100100692236&group=Waste+Collection").then(response => response.text());
    const json = await XMLparser.toJson(xml, {object: true});
    const formattedData = formatData(json);

    const newResponse = {
        updatedOn: new Date().toISOString(),
        bins: {...formattedData}
    };

    console.log("Fetched new data:\n", newResponse);

    await handleNewData(newResponse);
    return newResponse;
};

const webhookRequest = async data => {
    const webhookResponse = await fetch(webhookKey, {
        method: "POST",
        body: JSON.stringify(data),
        headers: {
            "Content-type": "application/json"
        }
    });

    if (!webhookResponse.ok) {
        console.error("Error sending webhook\n", webhookResponse.status, webhookResponse.statusText);
        return;
    }

    console.log(await webhookResponse.text());
};

const handleNewData = async data => {
    if (!data.bins.garden.isDue && !data.bins.waste.isDue && !data.bins.recycling.isDue) {
        console.log("No bins are being collected today or tomorrow");
        return;
    }

    try {
        let tomorrowsBins = [];
        let todaysBins = [];

        Object.entries(data.bins).forEach(bin => {
            if (!bin[1].isDue) {
                return;
            }
            
            if (bin[1].daysUntilDue.toLowerCase() === "today") {
                todaysBins.push(bin[0]);
                return;
            }
            
            if (bin[1].daysUntilDue.toLowerCase() === "tomorrow") {
                tomorrowsBins.push(bin[0]);
                return;
            }

            console.warn("Unrecognised days until bin due string: " + bin[1].daysUntilDue.toLowerCase());
        });

        const createMessage = (bins, day) => {
            if (bins.length === 0) {
                return "";
            }

            let message = "";
        
            bins.forEach((bin, index) => {
                if (index === 0) {
                    message = bin.replace(/^\w/, char => char.toUpperCase());
                    return;
                }
                if (index === bins.length - 1) {
                    message += ` and ${bin}`
                }
            });
        
            if (bins.length > 1) {
                message += " bins are "
            } else {
                message += " bin is "
            }
        
            message += `being collected ${day}.`;

            return message;
        }

        if (todaysBins.length > 0 && tomorrowsBins.length > 0) {
            console.log(createMessage(todaysBins, "today")+" "+createMessage(tomorrowsBins, "tomorrow"));
            await webhookRequest({
                value1: createMessage(todaysBins, "today")+" "+createMessage(tomorrowsBins, "tomorrow")
            });
            return;
        }
        
        console.log(createMessage(todaysBins, "today")+createMessage(tomorrowsBins, "tomorrow"));
        await webhookRequest({
            value1: createMessage(todaysBins, "today")+createMessage(tomorrowsBins, "tomorrow")
        });
    } catch (error) {
        console.error(error);
    }
}

schedule.scheduleJob('0 6,18 * * *', async () => {
    try {
        console.log("Checking bin data at " + new Date().toISOString());
        const data = await buildResponseData();
        await handleNewData(data);
    } catch (error) {
        console.log(error);
    }
});

const render = templateData => {
    let HTML;
    ejs.renderFile("./templates/main.ejs", templateData, {debug: true}, (err, string) => {
        if (err) {
            console.error("Error rendering template\n", err);
            HTML = `:( Error when rendering the template:<br>${err}`;
            return;
        }
        HTML = string;
    });
    return HTML;
};

app.use(function(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

const dataForLoad = buildResponseData();
app.get('/api/bins', function (req, res) {
    res.json(dataForLoad);
});

app.get('/', function (req, res) {
    res.send(render(response));
});

app.listen(port, function () {
    console.log('Bin bot listening on port ' + port);
});