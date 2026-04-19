@echo off
title Push NexTrack to GitHub
color 0A

echo.
echo  Pushing NexTrack to GitHub...
echo.

cd /d "%~dp0"

:: Init git if needed
if not exist ".git" (
    git init
    git branch -M main
)

:: Set remote to your repo
git remote remove origin 2>nul
git remote add origin https://github.com/snb9042/findtrack.git

:: Stage everything except ignored files
git add -A

:: Commit
git commit -m "NexTrack v2 — unified Apple + Google tracking with geofencing and AI patterns"

:: Push (force to overwrite findtrack repo with NexTrack)
echo.
echo  Pushing to https://github.com/snb9042/findtrack...
echo  You will be prompted for GitHub credentials.
echo.
git push -u origin main --force

echo.
echo  Done! Check https://github.com/snb9042/findtrack
echo.
pause
