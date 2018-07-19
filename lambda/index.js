const fetch = require('node-fetch');
const dateFns = require('date-fns');
const XMLparser = require('xml2js').parseString;

const dataURL = "http://www.newport.gov.uk/model/ncc/services/myNewportService.cfc?method=getPropertyData&uprn=100100692236&group=Waste+Collection";

const mapIndexToBinType = {
    0: "waste",
    1: "garden",
    2: "recycling"
}

const convertXMLtoJSON = xml => new Promise((resolve, reject) => {
    XMLparser(xml, function (err, result) {
        if (err) {
            reject(err);
        }
        resolve(result);
    });
});

const getData = async () => {
    let response;
    let xml;
    let json;

    try {
        response = await fetch(dataURL);    
    } catch (error) {
        throw new Error(error);
    }

    // Retry the request twice, the Newport site is dodgy and often doesn't give a response
    if (!response.ok) {
       response = await fetch(dataURL);
    }
    if (!response.ok) {
       response = await fetch(dataURL);
    }

    // Give up, we've tried enough!
    if (!response.ok) {
        throw new Error(`${response.status}: ${response.statusText} \nError when trying fetch Newport Council data`)
    }

    try {
        xml = await response.text();
        json = await convertXMLtoJSON(xml);
    } catch (error) {
        console.error("Error parsing response data", error);
        console.log("Trying to fetch data again");
        
        xml = await response.text();
        json = await convertXMLtoJSON(xml);
    }

    return json;
};

const getDueBins = data => {
    const today = new Date();
    const todaysDate = today.toLocaleDateString("en-GB");
    const tomorrow = dateFns.addDays(today, 1);
    const tomorrowsDate = new Date(tomorrow).toLocaleDateString("en-GB");
    // const tomorrowsDate = '7/9/2018';

    const getBinDates = bin => {
        const dateParts = bin.item[0].title[0].split(" ");
        const dayNumber = dateParts[1].match(/^[0-9]*/);
        const month = dateParts[2];
        const year = dateParts[3];

        const binDate = new Date(`${month} ${dayNumber}, ${year} 23:00:00`);
        const binCollectionTimeHasPassed = dateFns.isAfter(binDate, new Date(today.getFullYear(), today.getMonth(), today.getDate(), 21, 11, 0, 0));
        // const binCollectionTimeHasPassed = false;

        return {
            binCollectionTimeHasPassed,
            collectedOn: binDate.toLocaleDateString("en-GB"),
            collectedOnISOString: binDate.toISOString()
        };
    };

    const isDue = dates => {
        if (tomorrowsDate === dates.collectedOn) {
            return true;
        }
        if (todaysDate === dates.collectedOn && !dates.binCollectionTimeHasPassed) {
            return true;
        }
        return false;
    };

    const getDueDay = collectionISODate => {
        const noOfDays = dateFns.distanceInWordsStrict(new Date(), collectionISODate, {unit: "d"});
        if (noOfDays.split(" ")[0] === "1") {
            return "tomorrow";
        }
        if (noOfDays.split(" ")[0] === "0") {
            return "today";
        }
        return noOfDays;
    };

    const dueBins = [];
    data.rss.channel.forEach((bin, index) => {
        const dates = getBinDates(bin);
        if (!isDue(dates)) {
            return;
        }
        dueBins.push({
            title: mapIndexToBinType[index],
            dueOn: getDueDay(dates.collectedOnISOString)
        });
    });

    return dueBins;
}

const formatData = data => {
    try {
        const formattedData = {
            updatedOn: new Date().toString(),
            dueBins: getDueBins(data)
        }
        return formattedData;
    } catch (error) {
        console.error("Error formatting data", error);
        throw new Error("Error formatting data");
    }
};

const buildMessage = bins => {
    console.log("Due bin/s: ", bins);

    if (bins.length === 0) {
        return "No bins due";
    }

    const buildMessageForDay = (bins, day) => {
        let message = "";

        bins.forEach((bin, index) => {
            if (index === 0) {
                message = bin.title.replace(/^\w/, char => char.toUpperCase());
                return;
            }
            if (index === bins.length - 1) {
                message += ` and ${bin.title}`
            }
        });

        if (bins.length > 1) {
            message += " bins are "
        } else {
            message += " bin is "
        }

        return message += `being collected ${day}.`;
    };

    let messageParts = [];
    const dueToday = bins.filter(bin => bin.dueOn === "today");
    const dueTomorrow = bins.filter(bin => bin.dueOn === "tomorrow");

    if (dueToday.length >= 1 && dueTomorrow.length >= 1) {
        messageParts[0] = buildMessageForDay(dueToday, "today");
        messageParts[1] = buildMessageForDay(dueTomorrow, "tomorrow");
        return messageParts.join(". ");
    };
    
    if (dueToday.length >= 1) {
        return buildMessageForDay(dueToday, "today");
    };
    
    if (dueTomorrow.length >= 1) {
        return buildMessageForDay(dueTomorrow, "tomorrow");
    };
}

const sendWebhook = async (message, webhookKey) => {
    const body = {
        value1: message
    };
    console.log(JSON.stringify(body));
    const response = await fetch(webhookKey, {
        method: "POST", 
        body: JSON.stringify(body),
        headers: {
            "Content-Type": "application/json"
        }
    });

    if (!response.ok) {
        throw new Error(`${response.status}: ${response.statusText} \nError sending webhook request`);
    }
};

exports.handler = async (event, context, callback) => {
    const webhookKey = process.env.WEBHOOK_URL;

    if (!webhookKey) {
        console.warn("No WEBHOOK_URL provided, unable to send IFTTT webhook POST");
    }
    
    console.log(`Webhook key: ${webhookKey}`);

    try {
        const data = await getData();
        const formattedData = formatData(data);

        if (!formattedData.dueBins || !formattedData.dueBins.length || formattedData.dueBins.length === 0) {
            callback(null, "No bins due today or tomorrow");
            return;
        }

        const successMsg = `Bin Bot alert: ${buildMessage(formattedData.dueBins)}`;
        await sendWebhook(successMsg, webhookKey);
        callback(null, successMsg);
    } catch (error) {
        callback(error);
    }
    
    return 'Bin Bot has run';
};
