"use strict";

var express = require("express");
var app = express();
var path = require("path");
const { Client } = require("pg");
require("dotenv").load();
var request = require("request");
var teamParser = require("./teamParser.js");
var dbVars = require("./dbVars");
var sslRedirect = require('heroku-ssl-redirect');

app.use(function forceLiveDomain(req, res, next) {
  // Don't allow user to hit Heroku now that we have a domain
  var host = req.get('Host');
  if (host === 'scorigami.herokuapp.com') {
    return res.redirect(301, 'https://nflscorigami.com/' + req.originalUrl);
  }
  return next();
});

app.use(sslRedirect())

var url = "https://feeds.nfl.com/feeds-rs/scores.json";

var scoresTable = "scores";
var metadataTable = "metadata";

if(process.env.DEBUG)
{
	console.log("DEBUG");
	scoresTable = "scores_DEBUG";
	metadataTable = "metadata_DEBUG";
}

var DATABASE_URL = process.env.DATABASE_URL;
var ssl = true;
if(!DATABASE_URL)
{
	DATABASE_URL = dbVars.DATABASE_URL;
	ssl = false;
}

const client = new Client({
	connectionString: DATABASE_URL,
	ssl: ssl,
});

client.connect();

app.use(express.static(__dirname + "/../.."));

var matrix = [];
var maxpts = 0;
var maxlosepts = 0;
var maxcount = 0;
var maxcount = 0;
var lastUpdated;
var tables = {scores:[], metadata:[]};
var newScorigami = [];

function updateData()
{
	console.log("fetching data");
	request(url, function(err0, res0, data)
	{
		if(!err0)
		{
			try
			{
				data = JSON.parse(data);
			}
			catch(e)
			{
				getData();
				return;
			}
			//if the game is regular or post season, continue, otherwise (preseason) ignore it
			if (data.seasonType === "REG" || data.seasonType === "POST")
			{
				//check the current week
				client.query("SELECT data_int FROM " + metadataTable + " WHERE description='current_week';", (err1, res1) =>
				{
					if(!err1)
					{
						var current_week = res1.rows[0].data_int;
						//if the current week does not match the current tracked week, change the current week and delete the tracked games (we won't be needing them any more)
						if(current_week !== data.week)
						{
							client.query("UPDATE " + metadataTable + " SET data_int=" + data.week + " WHERE description='current_week';DELETE FROM " + metadataTable + " WHERE description='tracked_game';", (err2, res2) => 
							{
								newScorigami = [];
								updateData();
							});
						}
						else
						{
							//get the list of tracked games
							client.query("SELECT data_int, data_text FROM " + metadataTable + " WHERE description='tracked_game';", (err2, res2) =>
							{	
								if(!err2)
								{
									var newgames = [];
									var secondHalf = false;
									//iterate through this week's games
									for (let game of data.gameScores)
									{
										//if the game is not over, ignore it
										if(game.score && (game.score.phase === "FINAL" || game.score.phase === "FINAL_OVERTIME"))
										{	
											var tracked = false;
											//if the game has already been tracked, ignore it
											for (let row of res2.rows) 
											{
												if(game.gameSchedule.gameId === row.data_int)
												{
													tracked = true;
													//console.log("game " + game.eid + " not tracked because it has already been tracked");
													if(row.data_text === "true" && !newScorigami.includes(game.gameSchedule.gameId))
													{
														newScorigami.push(game.gameSchedule.gameId);
													}
													break;
												}
											}
											//if the game is over, and has not been tracked, add it to the list of untracked games
											if(!tracked)
											{
												newgames.push(game);
											}
										}
										else
										{
											//console.log("game " + game.eid + " not tracked because it has not ended");
										}
										//if there is a game in the second half, set secondHalf to true
										if(game.score && (game.score.phase === "Q3" || game.score.phase === "Q4" || game.score.phase.startsWith("OT")))
										{
											secondHalf = true;
										}
									}

									//if there is a game in the second half, run tick every minute instead of every hour
									if(secondHalf)
									{
										console.log("secondHalf");
										setTimeout(tick, 1000 * 60);
									}
									var finishedQueries = 0;
									var queryString = "";
									//iterate through the list of untracked games
									for (var i = 0; i < newgames.length; i++)
									{
										(function(game, index)
										{
											var homeScore = game.score.homeTeamScore.pointTotal;
											var awayScore = game.score.visitorTeamScore.pointTotal;

											//get the score row from the database
											var pts_win = homeScore > awayScore ? homeScore : awayScore;
											var pts_lose = homeScore > awayScore ? awayScore : homeScore;
											var homeWin = homeScore > awayScore;
											client.query("SELECT count FROM " + scoresTable + " WHERE (pts_win=" + pts_win + " AND pts_lose=" + pts_lose + ");", (err3, res3) =>
											{
												if(!err3)
												{
													//aCompleteFuckingMiracleHasHappened is true when 2 games achieve scorigami with same score at the same time
													var aCompleteFuckingMiracleHasHappened = false;
													for (var j = 0; j < index; j++)
													{
														var game2 = newgames[j];
														var homeScore2 = game2.score.homeTeamScore.pointTotal;
														var awayScore2 = game2.score.visitorTeamScore.pointTotal;
														if(homeScore === homeScore2 && awayScore === awayScore2)
														{
															aCompleteFuckingMiracleHasHappened = true;
														}
													}
													var homeTeam = game.gameSchedule.homeDisplayName;
													var awayTeam = game.gameSchedule.visitorDisplayName;
													var winTeam = (homeWin ? homeTeam : awayTeam);
													var loseTeam = (homeWin ? awayTeam : homeTeam);
													var date = Math.floor(game.gameSchedule.gameId / 100).toString();
													var gamelink = "https://www.pro-football-reference.com/boxscores/" + date + "0" + teamParser.getShorthandName(game.gameSchedule.homeTeam.abbr) + ".htm";
													date = date.substr(0, 4) + "-" + date.substr(4, 2) + "-" + date.substr(6, 2);
													//if the game score has been achieved before (in database), increment the count and add it to the list of tracked games
													if(res3.rows[0] || aCompleteFuckingMiracleHasHappened)
													{
														queryString += "UPDATE " + scoresTable;
														queryString += " SET count=count+1";
														queryString += ", last_date=to_date('" + date + "', 'YYYY-MM-DD')";
														queryString += ", last_team_win='" + winTeam;
														queryString += "', last_team_lose='" + loseTeam;
														queryString += "', last_team_home='" + homeTeam;
														queryString += "', last_team_away='" + awayTeam;
														queryString += "', last_link='" + gamelink;
														queryString += "' WHERE (pts_win=" + pts_win + " AND pts_lose=" + pts_lose + ");\n";

														queryString += "INSERT INTO " + metadataTable + " (description, data_int, data_text) VALUES ('tracked_game', " + game.gameSchedule.gameId + ", 'false');\n";
														
														//queryString += "UPDATE " + scoresTable + " SET count=count+1 WHERE (pts_win=" + pts_win + " AND pts_lose=" + pts_lose + ");\n";
													}
													//if the game score has not been achieved before (not in database), add it to the database and add it to the list of tracked games
													else
													{
														queryString += "INSERT INTO " + scoresTable + " (pts_win, pts_lose, count, first_date, first_team_win, first_team_lose, first_team_home, first_team_away, first_link, last_date, last_team_win, last_team_lose, last_team_home, last_team_away, last_link) ";
														queryString += "VALUES (" + pts_win;
														queryString += ", " + pts_lose;
														queryString += ", 1";
														queryString += ", to_date('" + date + "', 'YYYY-MM-DD')";
														queryString += ", '" + winTeam;
														queryString += "', '" + loseTeam;
														queryString += "', '" + homeTeam;
														queryString += "', '" + awayTeam;
														queryString += "', '" + gamelink;
														queryString += "', to_date('" + date + "', 'YYYY-MM-DD')";
														queryString += ", '" + winTeam;
														queryString += "', '" + loseTeam;
														queryString += "', '" + homeTeam;
														queryString += "', '" + awayTeam;
														queryString += "', '" + gamelink;
														queryString += "');\n";
														queryString += "INSERT INTO " + metadataTable + " (description, data_int, data_text) VALUES ('tracked_game', " + game.gameSchedule.gameId + ", 'true');\n";

														newScorigami.push(game.gameSchedule.gameId);
													}
													finishedQueries++;
													if(finishedQueries >= newgames.length)
													{
														client.query(queryString, (err4, res4) => 
														{
															if(!err4)
															{
																getData();
															}
															else
															{
																console.log("There was an error updating data: 4");
																getData();
															}
														});
													}
												}
												else
												{
													console.log("There was an error updating data: 3");
													getData();
												}
											});
										})(newgames[i], i);
									}
									if(newgames.length === 0)
									{
										getData();
									}
								}
								else
								{
									console.log("There was an error updating data: 2");
									getData();
								}
							});
						}
					}
					else
					{
						console.log("There was an error updating data: 1");
						getData();
					}
				});
			}
			else
			{
				//console.log("no games tracked because it is not a regular or post season week");
				getData();
			}
		}
		else
		{
			console.log("There was an error updating data: 0");
			getData();
		}
	});
}

function getData()
{
	client.query("SELECT * FROM " + scoresTable + ";", (err, res) =>
	{
		if(!err)
		{
			var newScores = [];
			var newmatrix = [];
			for (let row of res.rows) 
			{
				newScores.push(row);
				if(row.pts_lose > maxlosepts)
				{
					maxlosepts = row.pts_lose;
				}
				if(row.pts_win > maxpts)
				{
					maxpts = row.pts_win;
				}
				if(row.count > maxcount)
				{
					maxcount = row.count;
				}
			}
			
			//create matrix with length and width equal to the max points, fill it with 0's
			for (var i = 0; i <= maxpts; i++)
			{
				newmatrix[i] = [];
				for(var j = 0; j <= maxpts; j++)
				{
					newmatrix[i][j] = {count: 0};
				}
			}
			//fill matrix with useful data
			for(var i = 0; i < newScores.length; i++)
			{
				newmatrix[newScores[i].pts_lose][newScores[i].pts_win] = newScores[i];
			}
			tables.scores = newScores;
			matrix = newmatrix;
			var dateOptions = { weekday: "short", year:"numeric", month:"short", day:"numeric", hour:"numeric", minute:"numeric", second:"numeric", timeZoneName:"short"};
			//lastUpdated = new Date().toUTCString();
			lastUpdated = new Date().toLocaleDateString("en-US", dateOptions);
			
			console.log("done " + lastUpdated);
		}
		else
		{
			console.log("There was an error getting data");
			throw err;
		}
		//renderPage();
	});

	client.query("SELECT * FROM " + metadataTable + ";", (err, res) =>
	{
		if(!err)
		{
			var newMetadata = [];
			for (let row of res.rows) 
			{
				newMetadata.push(row);
			}
			tables.metadata = newMetadata;
		}
	});
}

function tick()
{
	updateData();
}

tick();

setInterval(tick, 1000 * 60 * 60);
	
app.get("/data", function(req, res)
{
	var data = {
		matrix: matrix,
		maxpts: maxpts,
		maxlosepts: maxlosepts,
		maxcount: maxcount,
		lastUpdated: lastUpdated,
		newScorigami: newScorigami
	};
	//console.log(data);
	res.json(data);
});
	
app.get("/copydb", function(req, res)
{
	res.json(tables);
});

app.get("/*", function(req, res)
{
	res.sendFile(path.join(__dirname+"/../../view/index.html"));
});

app.listen(process.env.PORT || 8081);
