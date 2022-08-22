import * as React from "react";
import { useEffect, useState } from "react";
import styled from "styled-components";
import "./App.css";
import { createMachine, interpret } from "xstate";
import { PlayerComponent } from "./PlayerComponent";
import { BoardComponent } from "./BoardComponent";
import { PlayerPhysics } from "./PlayerPhysics";
import { BoardPhysics } from "./BoardPhysics";
import { UserCell } from "./UserCell";
import { BoardCell } from "./BoardCell";
import {
    _ENABLE_UP_KEY,
    BOARD_COLS,
    BOARD_ROWS,
    EMPTY,
    ENABLE_INSTANT_DROP,
    ENABLE_SMOOTH_FALL,
    interp,
    interpKeydownMult,
    interpMax,
    interpRate,
    MIN_WORD_LENGTH,
    TBD,
} from "./setup";

// Unpack words that can be created.
let validWords: Set<string> | undefined;
fetch("lexicons/Google20000.txt")
    .then((response) => response.text())
    .then((data) => {
        // Do something with your data
        validWords = new Set(data.split("\n"));
    });

// Style of encompassing board.
const BoardStyled = styled.div`
  display: inline-grid;
  grid-template-rows: repeat(${BOARD_ROWS}, 30px);
  grid-template-columns: repeat(${BOARD_COLS}, 30px);
  border: solid red 4px;
`;

// Terminology: https://tetris.fandom.com/wiki/Glossary
// Declaration of game states.
const stateMachine = createMachine({
    initial: "spawningBlock",
    states: {
        spawningBlock: { on: { SPAWN: "placingBlock" } },
        placingBlock: { on: { TOUCHINGBLOCK: "lockDelay" } },
        lockDelay: { on: { LOCK: "fallingLetters", UNLOCK: "placingBlock" } },
        fallingLetters: { on: { GROUNDED: "checkingMatches" } },
        checkingMatches: { on: { PLAYING_ANIM: "playMatchAnimation" } },
        playMatchAnimation: {
            on: { DO_CHAIN: "checkingMatches", DONE: "spawningBlock" },
        },
    },
    predictableActionArguments: true,
});

// Handle states.
const stateHandler = interpret(stateMachine).onTransition((state) => {
    console.log("   STATE:", state.value);
});
stateHandler.start();

// Various game logic vars.

/* Note: with 60 FPS, this is a float (16.666..7). Might run into issues. */
const framesPerSecLimit = 60;

const frameStep = 1000 / framesPerSecLimit;
let accumFrameTime = 0;
let prevFrameTime = performance.now();

/* Block cell coordinates that were placed/dropped.. */
const placedCells = new Set();

const matchedCells = new Set();
let lockStart = null;

/* The amount of time it takes before a block locks in place. */
const lockMax = 1500;

let matchAnimStart = null;
const matchAnimLength = 750;
let isMatchChaining = false;
let isPlayerMovementEnabled = false;
let didInstantDrop = false;

let leaveGroundPenalty = 0;
const leaveGroundRate = 250;

export function GameLoop() {
    const [boardPhysics, _setBoardPhysics] = useState(
        new BoardPhysics(BOARD_ROWS, BOARD_COLS),
    );
    const [_boardCellMatrix, setBoardCellMatrix] = useState(
        boardPhysics.boardCellMatrix,
    );

    const [playerPhysics, _setPlayerPhysics] = useState(
        new PlayerPhysics(boardPhysics),
    );
    const [_adjustedCells, setAdjustedCells] = useState(
        playerPhysics.adjustedCells,
    );
    const [isPlayerVisible, setPlayerVisibility] = useState(true);

    const [matchedWords, setMatchedWords] = useState([]);

    useEffect(() => {
        globalThis.requestAnimationFrame(loop);
        globalThis.addEventListener("keydown", updatePlayerPos);
    }, []);

    function handleRotation(isClockwise, board) {
        // TODO: debug this & rotateCells for !isclockWise
        const rotatedCells = playerPhysics.rotateCells(
            playerPhysics.cells,
            isClockwise,
        );

        let rotatedCellsAdjusted = rotatedCells.map((cell) =>
            playerPhysics.getAdjustedUserCell(cell)
        );

        // Get the overlapping cell's respective index in non-adjusted array.
        const overlappingCellIndex = rotatedCellsAdjusted.findIndex((cell) => (
            !playerPhysics.isInCBounds(cell.c) ||
            !playerPhysics.isInRBounds(cell.r) ||
            board[cell.r][cell.c].char !== EMPTY
        ));
        // If there's no overlap, place it. Otherwise, shift it in the opposite direction of the overlapping cell.
        if (overlappingCellIndex === -1) {
            // If rotation puts a block right underneath a placed block, set interp to 0.
            const isAdjacentToGround = rotatedCellsAdjusted.some((cell) => {
                return !playerPhysics.isInRBounds(cell.r + 1) ||
                    board[cell.r + 1][cell.c].char !== EMPTY;
            });
            if (isAdjacentToGround) {
                interp.val = 0;
            }
            playerPhysics.cells = rotatedCells;
            playerPhysics.adjustedCells = rotatedCellsAdjusted;
            playerPhysics.hasMoved = true;
        } else {
            console.assert(playerPhysics.adjustedCells.length === 2);
            // Get direction of overlapping cell.
            const dr = Math.floor(playerPhysics.layout.length / 2) -
                rotatedCells[overlappingCellIndex].r;
            const dc = Math.floor(playerPhysics.layout[0].length / 2) -
                rotatedCells[overlappingCellIndex].c;
            // Shift it.
            for (const cell of rotatedCells) {
                cell.r += dr;
                cell.c += dc;
            }
            rotatedCellsAdjusted = rotatedCells.map((cell) =>
                playerPhysics.getAdjustedUserCell(cell)
            );
            // Check for overlaps with shifted cells.
            const isOverlapping = rotatedCellsAdjusted.some((cell, i) =>
                !playerPhysics.isInCBounds(cell.c) ||
                !playerPhysics.isInRBounds(cell.r) ||
                board[cell.r][cell.c].char !== EMPTY
            );
            if (!isOverlapping) {
                playerPhysics.cells = rotatedCells;
                playerPhysics.adjustedCells = rotatedCellsAdjusted;
                playerPhysics.hasMoved = true;
            }
        }
    }

    function updatePlayerPos(
        { code }: { code: string },
    ): void {
        if (!isPlayerMovementEnabled) {
            return;
        }
        const board = boardPhysics.boardCellMatrix;
        const r = playerPhysics.pos[0];
        const c = playerPhysics.pos[1];
        const areTargetSpacesEmpty = (dr, dc) =>
            playerPhysics.adjustedCells.every((cell) => {
                return board[cell.r + dr][cell.c + dc].char === EMPTY;
            });
        if ("ArrowLeft" == code) {
            // Move left.
            if (
                playerPhysics.isInCBounds(
                    playerPhysics.getAdjustedLeftmostC() - 1,
                ) &&
                // Ensure blocks don't cross over to ground higher than it, regarding interpolation.
                (!ENABLE_SMOOTH_FALL ||
                    playerPhysics.isInRBounds(
                        playerPhysics.getAdjustedBottomR() +
                            Math.ceil(interp.val / interpMax),
                    )) &&
                areTargetSpacesEmpty(
                    Math.ceil(ENABLE_SMOOTH_FALL ? interp.val / interpMax : 0),
                    -1,
                )
            ) {
                playerPhysics.setPos(r, c - 1);
                playerPhysics.hasMoved = true;
            }
        } else if ("ArrowRight" == code) {
            // Move right.
            if (
                playerPhysics.isInCBounds(
                    playerPhysics.getAdjustedRightmostC() + 1,
                ) &&
                // Ensure blocks don't cross over to ground higher than it, regarding interpolation.
                (!ENABLE_SMOOTH_FALL ||
                    playerPhysics.isInRBounds(
                        playerPhysics.getAdjustedBottomR() +
                            Math.ceil(interp.val / interpMax),
                    )) &&
                areTargetSpacesEmpty(
                    Math.ceil(ENABLE_SMOOTH_FALL ? interp.val / interpMax : 0),
                    1,
                )
            ) {
                playerPhysics.setPos(r, c + 1);
                playerPhysics.hasMoved = true;
            }
        } else if ("ArrowDown" == code) {
            // Move down faster.
            if (
                playerPhysics.getAdjustedBottomR() + 1 < BOARD_ROWS &&
                areTargetSpacesEmpty(1, 0)
            ) {
                if (ENABLE_SMOOTH_FALL) {
                    interp.val += interpRate * interpKeydownMult;
                } else {
                    playerPhysics.setPos(r + 1, c);
                }
            }
        } else if ("KeyZ" == code) {
            // Rotate left.
            handleRotation(false, board);
        } else if ("ArrowUp" == code || "KeyX" == code) {
            // Rotate right.
            handleRotation(true, board);
        } else if ("Space" == code) {
            // Instant drop.
            if (ENABLE_INSTANT_DROP) {
                let ground_row = boardPhysics.rows;
                playerPhysics.adjustedCells.forEach((cell) =>
                    ground_row = Math.min(
                        ground_row,
                        boardPhysics.getGroundHeight(cell.c, cell.r),
                    )
                );
                const mid = Math.floor(playerPhysics.layout.length / 2);
                // Offset with the lowest cell, centered around layout's midpoint.
                let dy = 0;
                playerPhysics.cells.forEach((cell) =>
                    dy = Math.max(dy, cell.r - mid)
                );
                playerPhysics.setPos(ground_row - dy, playerPhysics.pos[1]); // + the lowest on that row if its >center
                playerPhysics.hasMoved = true;
                didInstantDrop = true;
            } else if (
                _ENABLE_UP_KEY && 0 <= playerPhysics.getAdjustedTopR() - 1 &&
                areTargetSpacesEmpty(-1, 0)
            ) {
                playerPhysics.setPos(r - 1, c);
                playerPhysics.hasMoved = true;
            }
        }
        playerPhysics.needsRerender = true;
    }

    function loop(timestamp) {
        const curTime = performance.now();
        accumFrameTime += curTime - prevFrameTime;
        prevFrameTime = curTime;

        // Update physics.
        while (accumFrameTime >= frameStep) {
            accumFrameTime -= frameStep;
            handleStates();
            if (isPlayerMovementEnabled) {
                const dr = playerPhysics.doGradualFall(
                    boardPhysics.boardCellMatrix,
                );
                playerPhysics.setPos(
                    playerPhysics.pos[0] + dr,
                    playerPhysics.pos[1],
                );
            }
            // Reset if spawn point is blocked.
            if (
                boardPhysics
                    .boardCellMatrix[playerPhysics.spawnPos[0]][
                        playerPhysics.spawnPos[1]
                    ].char !== EMPTY
            ) {
                boardPhysics.resetBoard(BOARD_ROWS, BOARD_COLS);
            }
        }

        // Update rendering.
        /* This works to re-render b.c. setPos() creates a new array. */
        setAdjustedCells(
            playerPhysics.adjustedCells,
        );
        setBoardCellMatrix(boardPhysics.boardCellMatrix);
        // gameState.setBoardCells(boardPhysics.boardCellMatrix);
        globalThis.requestAnimationFrame(loop);
    }

    function isPlayerTouchingGround() {
        return playerPhysics.adjustedCells.some((cell) => {
            return cell.r >= boardPhysics.getGroundHeight(cell.c, cell.r);
        });
    }

    function dropFloatingCells(board: BoardCell[][]): number[][] {
        // Returns 2 arrays: 1 array for the coords of the floating cells, 1 array for the new coords of the floating cells.
        const added = [];
        const removed = [];
        for (let r = BOARD_ROWS - 2; r >= 0; --r) {
            for (let c = BOARD_COLS - 1; c >= 0; --c) {
                if (
                    board[r][c].char !== EMPTY &&
                    board[r + 1][c].char === EMPTY
                ) {
                    const g = boardPhysics.getGroundHeight(c, r);
                    board[g][c].char = board[r][c].char;
                    board[r][c].char = EMPTY;
                    // Update cell in placedCells.
                    added.push([g, c]);
                    removed.push([r, c]);
                }
            }
        }
        return [added, removed];
    }

    function findWords(arr: UserCell[], reversed: boolean): number[] {
        // Given the array of a row or column, returns the left and right indices (inclusive) of the longest word.
        const contents = reversed
            ? arr.map((cell) => cell.char === EMPTY ? "-" : cell.char).reverse()
                .join("")
            : arr.map((cell) => cell.char === EMPTY ? "-" : cell.char).join("");
        // Look for words in row
        let resLeft = -1;
        let resRight = -1;
        for (let left = 0; left < contents.length; ++left) {
            for (
                let right = left + MIN_WORD_LENGTH - 1;
                right < contents.length;
                ++right
            ) {
                const cand = contents.slice(left, right + 1);
                if (validWords.has(cand)) {
                    if (right - left > resRight - resLeft) {
                        resRight = right;
                        resLeft = left;
                    }
                }
            }
        }
        return reversed
            ? [
                contents.length - resRight - 1,
                resRight - (resLeft) + (contents.length - resRight - 1),
            ]
            : [resLeft, resRight];
    }

    function handleStates() {
        if ("spawningBlock" == stateHandler.state.value) {
            // Reset player.
            isPlayerMovementEnabled = true;
            setPlayerVisibility(true);
            playerPhysics.needsRerender = true;

            // Reset penalty.
            leaveGroundPenalty = 0;

            placedCells.clear();
            stateHandler.send("SPAWN");
        } else if ("placingBlock" == stateHandler.state.value) {
            if (isPlayerTouchingGround()) {
                stateHandler.send("TOUCHINGBLOCK");
                lockStart = performance.now();
            }
        } else if ("lockDelay" == stateHandler.state.value) {
            const lockTime = performance.now() - lockStart + leaveGroundPenalty;

            if (playerPhysics.hasMoved && !isPlayerTouchingGround()) {
                // Player has moved off of ground.
                leaveGroundPenalty += leaveGroundRate;
                stateHandler.send("UNLOCK");
            } else if (lockMax <= lockTime || didInstantDrop) {
                const newBoard = boardPhysics.boardCellMatrix.slice();
                playerPhysics.adjustedCells.forEach((cell) => {
                    placedCells.add([cell.r, cell.c]);
                    // Give player cells to board.
                    newBoard[cell.r][cell.c].char = cell.char;
                });
                // Allow React to see change with a new object:
                boardPhysics.boardCellMatrix = newBoard;
                interp.val = 0;
                // Allow React to see change with a new object:
                playerPhysics.resetBlock();
                didInstantDrop = false;

                stateHandler.send("LOCK");
                // Disable player block features.
                isPlayerMovementEnabled = false;
                setPlayerVisibility(false);
            }
        } else if ("fallingLetters" == stateHandler.state.value) {
            // For each floating block, move it 1 + the ground.
            const [added, _removed] = dropFloatingCells(
                boardPhysics.boardCellMatrix,
            );
            added.forEach((coord) => placedCells.add(coord));
            stateHandler.send("GROUNDED");
        } else if ("checkingMatches" == stateHandler.state.value) {
            // Allocate a newBoard to avoid desync between render and board (React, pls).
            const newBoard = boardPhysics.boardCellMatrix.slice();
            // TODO: Remove repeated checks when placedCells occupy same row or col.
            let hasRemovedWord = false;
            const affectedRows = new Set(
                [...placedCells].map((cell) => cell[0]),
            );
            const affectedCols = new Set(
                [...placedCells].map((cell) => cell[1]),
            );
            affectedRows.forEach((r) => {
                // Row words
                const [row_left, row_right] = findWords(newBoard[r], false);
                // Remove word, but ignore when a candidate isn't found.
                if (row_left !== -1) {
                    matchedWords.push(
                        newBoard[r].slice(row_left, row_right + 1).map((cell) =>
                            cell.char
                        ).join(""),
                    );
                    for (let i = row_left; i < row_right + 1; ++i) {
                        matchedCells.add([r, i]);
                    }
                    hasRemovedWord = true;
                }
            });
            affectedCols.forEach((c) => {
                // Column words
                let [col_top, col_bot] = findWords(
                    boardPhysics.boardCellMatrix.map((row) => row[c]),
                    false,
                );
                const [col_topR, col_botR] = findWords(
                    boardPhysics.boardCellMatrix.map((row) => row[c]),
                    true,
                );
                // Use reversed word if longer.
                let isColReversed = false;
                if (col_botR - col_topR > col_bot - col_top) {
                    col_top = col_topR;
                    col_bot = col_botR;
                    isColReversed = true;
                }
                // Remove word, but ignore when a candidate isn't found.
                if (col_top !== -1) {
                    matchedWords.push(
                        isColReversed
                            ? boardPhysics.boardCellMatrix.map((row) => row[c])
                                .slice(col_top, col_bot + 1).map((cell) =>
                                    cell.char
                                ).reverse().join("")
                            : boardPhysics.boardCellMatrix.map((row) => row[c])
                                .slice(col_top, col_bot + 1).map((cell) =>
                                    cell.char
                                ).join(""),
                    );
                    for (let i = col_top; i < col_bot + 1; ++i) {
                        matchedCells.add([i, c]);
                    }
                    hasRemovedWord = true;
                }
            });

            setMatchedWords(matchedWords.slice()); // TODO: If expensive, force a re-render in a cheaper way.

            // Remove characters
            matchedCells.forEach((coord) => {
                // newBoard[coord[0]][coord[1]].char = EMPTY;
                newBoard[coord[0]][coord[1]].hasMatched = true;
            });
            boardPhysics.boardCellMatrix = newBoard;
            if (hasRemovedWord) {
                isMatchChaining = true;
                matchAnimStart = performance.now();
            }
            stateHandler.send("PLAYING_ANIM");
        } else if ("playMatchAnimation" == stateHandler.state.value) {
            if (isMatchChaining) {
                const animTime = performance.now() - matchAnimStart;
                if (matchAnimLength <= animTime) {
                    // Also remove characters. (hasMatched)
                    const newBoard = boardPhysics.boardCellMatrix.slice();
                    matchedCells.forEach((coord) => {
                        newBoard[coord[0]][coord[1]].char = EMPTY;
                        newBoard[coord[0]][coord[1]].hasMatched = false;
                    });

                    // Drop all characters.
                    const [added, _removed] = dropFloatingCells(newBoard);
                    boardPhysics.boardCellMatrix = newBoard;
                    placedCells.clear();
                    added.forEach((coord) => placedCells.add(coord));

                    // Go back to checkingMatches to see if dropped letters causes more matches.
                    matchedCells.clear();
                    isMatchChaining = false;
                    stateHandler.send("DO_CHAIN");
                }
            } else {
                stateHandler.send("DONE");
            }
        }
        playerPhysics.hasMoved = false;
    }

    const appStyle = {
        display: "flex",
        border: "solid green 4px",
        flexWrap: "wrap",
        flexDirection: "row",
    };

    return (
        <div style={appStyle}>
            <BoardStyled>
                <PlayerComponent
                    isVisible={isPlayerVisible}
                    adjustedCells={playerPhysics.adjustedCells}
                />
                <BoardComponent
                    boardCellMatrix={boardPhysics.boardCellMatrix}
                />
            </BoardStyled>
            <WordList displayedWords={matchedWords} />
        </div>
    );
}

const WordList = React.memo(
    ({ displayedWords }: { displayedWords: string[] }) => {
        const wordStyle = {
            background: "yellow",
        };

        const outerStyle = {
            display: "flex",
            flexDirection: "column",
        };

        const scrollBoxStyle = {
            flex: "auto",
            overflowY: "auto",
            height: "0px",
        };

        return (
            <div style={outerStyle}>
                <div flex={"none"}>
                    Matched Words ({displayedWords.length})
                </div>
                <article style={scrollBoxStyle}>
                    <>
                        {displayedWords.map((word, i) => (
                            // Invert the key to keep scroll bar at bottom if set to bottom.
                            <div
                                key={displayedWords.length - i}
                                style={wordStyle}
                            >
                                {word}
                            </div>
                        ))}
                    </>
                </article>
            </div>
        );
    },
);
