import { Request, Response } from 'express';
import { genLinearDraftOrder } from '../utils/genDraftOrder';
import { genSnakeDraftOrder } from '../utils/genDraftOrder';
import { Recipient, sendEmailInvites } from '../utils/sendInviteEmail';
import { getUserDraftGrade } from '../utils/draft/draftGrade';
import { sendDraftSummaryEmail } from '../utils/sendDraftSummaryEmail';
const jwt = require('jsonwebtoken');
import dotenv from 'dotenv';
dotenv.config();
const db = require("../db"); // Connection for querying the Postgres database

class DraftsModel {

    public async deleteDraft(req: Request) {
        const {draftId} = req.query;

        await db.query(`
            DELETE FROM draft_order WHERE draft_id = $1;`, [
            draftId
        ]);
        await db.query(`
            DELETE FROM draft_pick WHERE draft_id = $1;`, [
            draftId
        ]);
        await db.query(`
            DELETE FROM pick_queue WHERE draft_id = $1;`, [
            draftId
        ]);
        await db.query(`
            DELETE FROM draft_user WHERE draft_id = $1;`, [
            draftId
        ]);
        await db.query(`
            DELETE FROM draft WHERE draft_id = $1;`, [
            draftId
        ]);
    }

    public async sendDraftSummaryEmail(req: Request) {
        const {userId, draftId, fanPtsTotal, draftRank, draftGrade} = req.body;

        const email = await db.query(`
            SELECT email FROM user_account WHERE user_id = $1;`, [
            userId
        ]);

        sendDraftSummaryEmail(email.rows[0].email, draftId, fanPtsTotal, draftRank, draftGrade);
        return 200;
    }

    // Retrieves summary data of all the drafts a user has created or joined
    public async getDrafts(req: Request) {
        const userId = req.query.userId;

        const drafts = await db.query(`
            WITH draft_order_counts AS (
                SELECT draft_id, COUNT(*)::INTEGER AS order_count
                FROM draft_order
                WHERE draft_id IN (SELECT draft_id FROM draft_user WHERE user_id = $1 AND is_invite_accepted = TRUE)
                GROUP BY draft_id
            )
            
            SELECT U.user_id, D.draft_id, draft_type, U.username, team_count,
                    scheduled_by_user_id, draft_type, scoring_type, pick_time_seconds,
                    is_started, COALESCE("DO".order_count, 0) AS order_count, -- Use COALESCE to handle NULL counts
                    pointguard_slots, shootingguard_slots, guard_slots,
                    smallforward_slots, powerforward_slots, forward_slots, center_slots,
                    utility_slots, bench_slots
            FROM draft_user AS DU
            LEFT JOIN draft AS D ON DU.draft_id = D.draft_id
            LEFT JOIN user_account AS U ON D.scheduled_by_user_id = U.user_id
            LEFT JOIN draft_order_counts AS "DO" ON D.draft_id = "DO".draft_id
            WHERE DU.user_id = $1 AND DU.is_invite_accepted = TRUE;
        `, [userId]);

        return drafts.rows;
    }

    public async startDraft(req: Request) {
        await db.query(`
            UPDATE draft SET is_started=true WHERE draft_id=$1`, [
                req.params.id
            ]
        );
        return 200;
    }

    public async toggleAutodraft(req: Request) {
        await db.query(
			`UPDATE draft_user
			SET is_autodraft_on=$1
			WHERE user_id=$2 AND draft_id=$3`, [
				req.body.isAutodraftOn, Number(req.body.userId), Number(req.body.userId)
			]
		);
        return 200
    }

    public async getDraftGrade(req: Request) {
        return getUserDraftGrade(Number(req.query.userId), Number(req.query.draftId));
    }
    

    public async getAutodraftStatus(req: Request) {
        const autodraftData = await db.query(
			`SELECT * FROM draft_user
			WHERE user_id=$1 AND draft_id=$2`, [
				Number(req.query.userId), Number(req.query.draftId)
			]
		);
        return autodraftData.rows[0]
    }

    /* Fetches basic draft info for a draft. 
    This includes settings like number of teams, team size, etc
    */
    public async getDraft(req: Request) {
        try {
            const draftId = req.params.id;

            if (draftId) {
                const draft = await db.query(`
                    SELECT * 
                    FROM draft 
                    WHERE draft_id = $1`, [
                        Number(draftId)
                ]);

                const draftUsers = await db.query(`
                    SELECT D.user_id, U.username
                    FROM draft_user AS D
                    INNER JOIN user_account as U
                    ON D.user_id = U.user_id
                    WHERE draft_id = $1
                    AND D.user_id != (
                        SELECT scheduled_by_user_id 
                        FROM draft AS D
                        WHERE D.draft_id = $1
                    )`, [
                        Number(draftId)
                ]);

                const ownerFirstPick = await db.query(`
                    SELECT MIN(pick_number) AS owner_first_pick
                    FROM draft_order
                    WHERE draft_id = $1
                    AND user_id = (
                        SELECT scheduled_by_user_id FROM draft WHERE draft_id = $1
                    )
                    `, [
                        Number(draftId)
                ]);

                draft.rows[0]['draft_members'] = draftUsers.rows;
                draft.rows[0]['owner_first_pick'] = ownerFirstPick.rows[0].owner_first_pick;

                return draft.rows[0];
            }
        } catch (error) {console.log(error)}
    }

    // Gets all undrafted players that are currently in a draft
    public async getPlayers(req: Request) {
        const {draftId} = req.query;

        const players = await db.query(
            `SELECT * 
            FROM points_draft_ranking AS R
            INNER JOIN nba_player as P
            ON R.player_id = P.player_id
            INNER JOIN nba_player_season_totals AS T
            ON P.player_id = T.player_id
            WHERE R.player_id NOT IN (
              SELECT player_id
              FROM draft_pick
              WHERE draft_id = $1
            )
            ORDER BY R.rank_number;`, [
              Number(draftId)
            ]
        );

        return players.rows;
    }

    // Adds a picked player from a draft to the draft_pick table
    public async pickPlayer(req: Request) {
        // A player can be picked by a user or bot.
        const {userId, playerId, draftId, botNumber} = req.body;
        
        await db.query(
            `INSERT INTO draft_pick (player_id, draft_id, picked_by_user_id, picked_by_bot_number)
            VALUES ($1, $2, $3, $4)`, [
                playerId, draftId, userId, botNumber
            ]
        );
    }

    // Gets all picks made by a user in a draft
    public async getPicks(req: Request) {
        const {userId, draftId} = req.query;
        const picks = await db.query(
            `SELECT T.assists_total, T.blocks_total,
            T.fieldgoals_attempted, T.threes_made, T.threes_attempted,
            T.fieldgoals_made, T.games_played, T.points_total, T.minutes_played,
            T.rebounds_total, T.steals_total, T.turnovers_total, NT.city_name, NT.team_name, NT.team_id,
            NT.team_abbreviation, P.first_name, P.last_name,P.is_center, P.is_pointguard, P.is_powerforward, 
            P.is_shootingguard, P.is_smallforward, P.player_age, P.player_id, R.rank_number,
            PP.points_total AS projected_points,
            PP.rebounds_total AS projected_rebounds, PP.assists_total AS projected_assists,
            PP.blocks_total AS projected_blocks, PP.steals_total AS projected_steals,
            PP.fieldgoal_percentage AS projected_fieldgoal_percentage,
            PP.games_played AS projected_games_played, PP.minutes_played AS projected_minutes_played,
            PP.turnovers_total AS projected_turnovers, PP.threepointers_total AS projected_threepointers,
            N.news_date, N.injury_status, N.analysis, N.summary, N.title, N.fantasy_outlook,
            D.picked_by_bot_number, D.picked_by_user_id, D.draft_id, D.pick_number
            FROM nba_player AS P
            LEFT JOIN points_draft_ranking as R
            ON R.player_id = P.player_id
            LEFT JOIN nba_player_season_totals AS T
            ON P.player_id = T.player_id
            LEFT JOIN nba_team AS NT
            ON P.team_id = NT.team_id
            LEFT JOIN nba_player_projections AS PP
            ON P.player_id = PP.player_id
            LEFT JOIN nba_player_news AS N
            ON P.player_id = N.player_id
            LEFT JOIN draft_pick AS D
            ON P.player_id = D.player_id
            LEFT JOIN user_account AS U
            ON D.picked_by_user_id = U.user_id
            WHERE D.picked_by_user_id = $1 AND D.draft_id = $2
            ORDER BY pick_number`, [
                Number(userId), Number(draftId)
            ]
        );
        return picks.rows;
    }

    // Gets all members in the draft
    public async getMembers(req: Request) {
        const draftId = req.query.draftId;

        // Gets all users the draft
        const draftUserData = await db.query(
            `SELECT U.user_id, draft_id, username
            FROM draft_user AS DU
            INNER JOIN user_account AS U
            ON DU.user_id = U.user_id
            WHERE DU.draft_id = $1`, [
                Number(draftId)
            ]
        );

        // If the draft has members that are not a user, then they are a 'bot'
        const draftBotsData = await db.query(
            `SELECT DISTINCT bot_number
            FROM draft_order
            WHERE draft_id = $1 AND bot_number IS NOT NULL
            ORDER BY bot_number`, [
                Number(draftId)
            ]
        );

        const draftUsers = draftUserData.rows;
        const draftBots = draftBotsData.rows.map((obj: any) => obj.bot_number);
        const draftMembers = {"draftUsers": draftUsers, "draftBots": draftBots}
        return draftMembers;
    }

    public async createDraft(req: Request) {
        let {draftType, scoringType, pickTimeSeconds,
            teamCount, pointguardSlots, shootingguardSlots,
            guardSlots, smallforwardSlots, powerforwardSlots, forwardSlots,
            centerSlots, utilitySlots, benchSlots,
            scheduledByUserId, scheduledByUsername, draftPosition, draftUserIds} = req.body;

        const recipientIds = [...draftUserIds];

        if (draftPosition-1<draftUserIds.length) {
            draftUserIds.splice(draftPosition-1, 0, scheduledByUserId);
        }
            
        // Sum of all position slots gives the total team size each team has
        const teamSize = pointguardSlots+shootingguardSlots
            +guardSlots+smallforwardSlots+powerforwardSlots
            +forwardSlots+centerSlots+utilitySlots+benchSlots;
    

        // Creates and returns the draft
        const createdDraft = await db.query(
            `INSERT INTO draft (draft_type, scoring_type, pick_time_seconds, 
                team_count, pointguard_slots, shootingguard_slots, guard_slots, 
                smallforward_slots, powerforward_slots, forward_slots,
                center_slots, utility_slots, bench_slots, scheduled_by_user_id) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING draft_id`, [
                draftType, scoringType, pickTimeSeconds, teamCount, pointguardSlots,
                shootingguardSlots, guardSlots, smallforwardSlots, powerforwardSlots,
                forwardSlots, centerSlots, utilitySlots, benchSlots, scheduledByUserId
            ]
        );

        // Order of which pick each member has
        let draftOrder: number[] = []

        if (draftType == "snake") {
            // Generates the draft order with a snake algorithm
            draftOrder = genSnakeDraftOrder(teamCount, teamSize);
        }
        else if (draftType == "linear") {
            // Generates the draft order with a linear algorithm
            draftOrder = genLinearDraftOrder(teamCount, teamSize);
        }

        // Inserts the draft order into the database
        let pickNumber = 1;
        for (const order of draftOrder) {
            if (order-1 < draftUserIds.length) {
                await db.query(
                `INSERT INTO draft_order (user_id, draft_id, pick_number)
                VALUES ($1, $2, $3)`, [
                    draftUserIds[order-1], createdDraft.rows[0].draft_id, pickNumber
                ]);
            }
            else if (order==draftPosition) {
                await db.query(
                    `INSERT INTO draft_order (user_id, draft_id, pick_number)
                    VALUES ($1, $2, $3)`, [
                    scheduledByUserId, createdDraft.rows[0].draft_id, pickNumber
                ]);
            }
            else {
                await db.query(
                    `INSERT INTO draft_order (bot_number, draft_id, pick_number)
                    VALUES ($1, $2, $3)`, [
                    order, createdDraft.rows[0].draft_id, pickNumber
                ]);
            }
            pickNumber += 1;
        }

        /* Inserts the draft's users' ids into the draft_user table so 
        that we know which drafts a user belongs to */
        await db.query(
            `INSERT INTO draft_user (user_id, draft_id, is_invite_accepted)
            VALUES ($1, $2, $3)`, [
                scheduledByUserId, createdDraft.rows[0].draft_id, true
            ]
        );

        draftUserIds.forEach(async (userId: number) => {
            if (userId != scheduledByUserId) {
                await db.query(
                    `INSERT INTO draft_user (user_id, draft_id)
                    VALUES ($1, $2)`, [
                        userId, createdDraft.rows[0].draft_id
                    ]
                );
            }
        });

        let recipients = await db.query(`
            SELECT user_id AS "userId", username, email FROM user_account
            WHERE user_id = ANY($1)
            `, [recipientIds]);

        recipients = recipients.rows.map((recipient: any) => ({
            ...recipient, // Copy the existing properties of the object
            draftId: createdDraft.rows[0].draft_id, // Add the new key-value pair
        }));

        await sendEmailInvites(recipients, scheduledByUsername);

        // Returns the draft id the draft that was created.
        return createdDraft.rows[0].draft_id;
    }

    public async updateDraft(req: Request) {
        let {draftType, scoringType, pickTimeSeconds,
            teamCount, pointguardSlots, shootingguardSlots,
            guardSlots, smallforwardSlots, powerforwardSlots, forwardSlots,
            centerSlots, utilitySlots, benchSlots, draftId,
            scheduledByUserId, scheduledByUsername, draftPosition, draftUserIds} = req.body;

        const recipientIds = [...draftUserIds];

        if (draftPosition-1<draftUserIds.length) {
            draftUserIds.splice(draftPosition-1, 0, scheduledByUserId);
        }
            
        // Sum of all position slots gives the total team size each team has
        const teamSize = pointguardSlots+shootingguardSlots
            +guardSlots+smallforwardSlots+powerforwardSlots
            +forwardSlots+centerSlots+utilitySlots+benchSlots;
    
        // Creates and returns the draft
        const updatedDraft = await db.query(
            `UPDATE draft SET draft_type=$1, scoring_type=$2, pick_time_seconds=$3, 
            team_count=$4, pointguard_slots=$5, shootingguard_slots=$6, guard_slots=$7, 
            smallforward_slots=$8, powerforward_slots=$9, forward_slots=$10,
            center_slots=$11, utility_slots=$12, bench_slots=$13, scheduled_by_user_id=$14
            WHERE draft_id=$15
            RETURNING draft_id`, [
                draftType, scoringType, pickTimeSeconds, teamCount, pointguardSlots,
                shootingguardSlots, guardSlots, smallforwardSlots, powerforwardSlots,
                forwardSlots, centerSlots, utilitySlots, benchSlots, scheduledByUserId,
                draftId
            ]
        );

        await db.query(
            `DELETE FROM draft_order WHERE draft_id=$1`, [draftId]
        );

        // Order of which pick each member has
        let draftOrder: number[] = []

        if (draftType == "snake") {
            // Generates the draft order with a snake algorithm
            draftOrder = genSnakeDraftOrder(teamCount, teamSize);
        }
        else if (draftType == "linear") {
            // Generates the draft order with a linear algorithm
            draftOrder = genLinearDraftOrder(teamCount, teamSize);
        }

        // Inserts the draft order into the database
        let pickNumber = 1;
        for (const order of draftOrder) {
            if (order-1 < draftUserIds.length) {
                await db.query(
                `INSERT INTO draft_order (user_id, draft_id, pick_number)
                VALUES ($1, $2, $3)`, [
                    draftUserIds[order-1], updatedDraft.rows[0].draft_id, pickNumber
                ]);
            }
            else if (order==draftPosition) {
                await db.query(
                    `INSERT INTO draft_order (user_id, draft_id, pick_number)
                    VALUES ($1, $2, $3)`, [
                    scheduledByUserId, updatedDraft.rows[0].draft_id, pickNumber
                ]);
            }
            else {
                await db.query(
                    `INSERT INTO draft_order (bot_number, draft_id, pick_number)
                    VALUES ($1, $2, $3)`, [
                    order, updatedDraft.rows[0].draft_id, pickNumber
                ]);
            }
            pickNumber += 1;
        }

        await db.query(
            `DELETE FROM draft_user
            WHERE user_id NOT IN (SELECT UNNEST($1::int[]))
            AND user_id != (SELECT scheduled_by_user_id FROM draft WHERE draft_id = $2)
            AND draft_id = $2;`, 
            [draftUserIds, updatedDraft.rows[0].draft_id]
        );

        draftUserIds.forEach(async (userId: number) => {
            if (userId != scheduledByUserId) {
                await db.query(
                    `INSERT INTO draft_user (user_id, draft_id)
                    SELECT $1, $2 WHERE NOT EXISTS (
                        SELECT 1 FROM draft_user WHERE user_id = $1 AND draft_id = $2
                    )`, [userId, updatedDraft.rows[0].draft_id]
                );
            }
        });

        let recipients = await db.query(`
            SELECT user_id AS "userId", username, email FROM user_account
            WHERE user_id = ANY($1)
            `, [recipientIds]);

        recipients = recipients.rows.map((recipient: any) => ({
            ...recipient, // Copy the existing properties of the object
            draftId: updatedDraft.rows[0].draft_id, // Add the new key-value pair
        }));

        await sendEmailInvites(recipients, scheduledByUsername);

        // Returns the draft id the draft that was created.
        return updatedDraft.rows[0].draft_id;
    }
}
  
module.exports = new DraftsModel();