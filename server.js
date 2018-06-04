const WebSocket = require('ws'),
	PouchDB = require('pouchdb-node');
var wss = new WebSocket.Server({ port: 3001 }),
	infosDb = new PouchDB('http://localhost:5984/wishing-infos'),
	musicsDb = new PouchDB('http://localhost:5984/wishing-musics'),
	spawn = require('child_process').spawn,
	request = require('request'),
	fs = require('fs'),
	queue = [],
	musicBase64 = '',
	imageBase64 = '',
	downloading = false,
	downloadPath = './',
	status = "Aucune action n'est en cours.";

console.log("Server started");

// Envoi du status du serveur chaque seconde
setInterval(function () {
	wss.clients.forEach(function each(client) {
		if (client.readyState == WebSocket.OPEN) {
			var msg = {
				type: 'updateStatus',
				value: status,
				isDownloading: downloading
			};
			client.send(JSON.stringify(msg));
		}
	});
}, 1000);

// Event de connexion
wss.on('connection', function connection(socketClient) {
	console.log('connection');

	socketClient.on('message', function incoming(incomingMessage) {
		console.log('message : ', incomingMessage);
		// Conversion du message String en JSON
		var request = JSON.parse(incomingMessage);
		switch(request.type) {
			case 'ready':
				console.log(request.type);
				var msgUpdateStatus = {
					type: 'updateStatus',
					value: status,
					isDownloading: downloading
				};
				/*var msgUpdateQueue = {
					type: 'updateQueue',
					value: queue
				};*/
				socketClient.send(JSON.stringify(msgUpdateStatus));
				//socketClient.send(JSON.stringify(msgUpdateQueue));
				break;
			default:
			// Vérification que l'URL est bien de YouTube
			if (/youtube/gi.test(request.url) || /youtu.be/gi.test(request.url)) {
				// Récupération des détails de la musique à dl
				getFileDetailsFromYouTube(request, function callback() {
					queue.push(request);

					//console.log("Ajout de la vidéo à la file d'attente");

					// On vérifie que le serveur ne dl pas
					if (!downloading) {
						downloadFromYouTube(queue.shift());
					}
					// Sinon mise à jour de la file d'attente côté client
					/*else {
						wss.clients.forEach(function each(client) {
							if (client.readyState == WebSocket.OPEN) {
								client.send('updateQueue', queue);
							}
						});
					}*/
				});
			// Sinon on prévient l'utilisateur que sa vidéo n'est pas de Youtube
			} else {
				var msgBadURL = {
					type: 'badURL'
				};
				console.log('bad URL');
				socketClient.send(JSON.stringify(msgBadURL));
			}
			break;
		}
	});
});

// Récupération des données de la vidéo
function getFileDetailsFromYouTube(query, callback) {
	var buffer = [];

	// Exécution de la commande youtube-dl de récupération de données
	var proc = spawn('youtube-dl'
		, ['--get-title', '--get-url', '--get-description', '--get-thumbnail', query.url]
	);

	// Remplissage du buffer de données
	proc.stdout.on('data', function (data) {
		buffer.push(data.toString());
	});

	// Mise à jour des données de la requête puis envoi vers le callback
	proc.on('exit', function (code) {
		// Supression des sauts de ligne en dernier caractère
		buffer.forEach(function(data, index, theBuffer) {
			if(data.charAt(data.length-1) == '\n') {
				theBuffer[index] = data.substring(0, data.length-1);
			}
		});

		query.title = buffer[0];
		query.downloadUrl = buffer[1];
		query.thumbnail = buffer[3];
		query.description = buffer[4];

		callback(query);
	});
}

// Téléchargement de vidéo YouTube
function downloadFromYouTube(query) {
	/*wss.clients.forEach(function each(client) {
		if (client.readyState == WebSocket.OPEN) {
				client.send('updateQueue', queue);
		}
	});*/

	// Téléchargement de l'image
	downloadThumbnail(query.thumbnail, 'image.jpg', function() {
		console.log('thumbnail downloaded');
	});

	// Lancement du dl
	var proc = spawn('youtube-dl'
		, ['--cookies=cookies.txt', '--extract-audio'
		, '--audio-format', 'mp3'
		, '-o', 'music.%(ext)s'
		// Téléchargement avec titre de la musique en nom de fichier
		//, '-o', '%(title)s.%(ext)s'
		, query.url],
		{
			cwd : downloadPath
		}
	);

	downloading = true;

	// Pendant le dl
	proc.stdout.on('data', function (data) {
		console.log('stdout: ' + data);
		/*status = {
			file : query,
			value : data.toString()
		};*/
		status = data.toString();
	});

	// En cas d'erreur de dl
	proc.stderr.on('data', function (data) {
		console.log('stderr: ' + data);
	});

	// Après le téléchargement
	proc.on('exit', function (code) {
		status = "Téléchargement de '<span class='color-blue'>" + query.title + "</span>' terminé.";
		console.log("download of '" + query.title + "' finished");
		downloading = false;

		status = "Envoi de '<span class='color-blue'>" + query.title + "</span>' sur le serveur.";
		console.log("uploading '" + query.title + "'..");

		// Envoi de la musique sur CouchDB
		uploadMusicOnCouchDB(query);

		// Si la file d'attente n'est pas vide on continue de dl
		if (queue.length) {
			downloadFromYouTube(queue.shift());
		}
	});
}

// Fonction d'envoi de la musique sur CouchDB
function uploadMusicOnCouchDB(query) {
	// Récupération des données en base64
	query.musicBase64 = fs.readFileSync('music.mp3').toString('base64');
	query.imageBase64 = fs.readFileSync('image.jpg').toString('base64');
	query.docId = 'music-' + query.title.toLowerCase().replace(/ /g, "-").replace('/', '').replace('#', '').replace('?', '').replace('%', '');

	if((query.title.match(/-/g)||[]).length == 1) {
		var titleSplit = query.title.split('-');
		query.artist = titleSplit[0].trim();
		query.title = titleSplit[1].trim();
	}

	// Envoi sur CouchDB docs
	infosDb.put({
		_id: query.docId,
		type: 'youtube-music',
		artist: query.artist,
		title: query.title,
		description: query.description
	}).then(function (response) {
		// Mise à jour du status
		console.log("upload of '" + query.title + "' infos finished");
		status = "Mise en ligne des informations <span class='color-green'>'" + query.title + "'</span> terminée.";
	}).catch(function (err) {
		console.log(err);
	});

	musicsDb.put({
		_id: query.docId,
		_attachments: {
			'image.jpg': {
				content_type: 'image/jpeg',
				data: query.imageBase64
			},
			'music.mp3': {
				content_type: 'audio/mp3',
				data: query.musicBase64
			}
		}
	}).then(function (response) {
		// Mise à jour du status
		console.log("upload of '" + query.title + "' music finished");
		status = "Mise en ligne de la musique <span class='color-green'>'" + query.title + "'</span> terminée.";
	}).catch(function (err) {
		console.log(err);
	});

}

// Téléchargement du thumbnail de la vidéo
function downloadThumbnail(url, filename, callback) {
	request.head(url, function(err, res ,body) {
		console.log('downloading the thumbnail..');
		console.log('thumbnail length : ', res.headers['content-length']);

		request(url).pipe(fs.createWriteStream(filename)).on('close', callback);
	});
}
