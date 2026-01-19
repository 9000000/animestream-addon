# AnimeStream Stream Testing Script
# Tests that CORRECT episodes are served, not just that streams exist

param(
    [string]$BaseUrl = "https://animestream-addon.keypop3750.workers.dev",
    [switch]$Local
)

if ($Local) {
    $BaseUrl = "http://127.0.0.1:8787"
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   AnimeStream Episode Verification" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Target: $BaseUrl" -ForegroundColor Gray
Write-Host ""

# Test cases with KNOWN correct AllAnime show IDs and expected episode numbers
# Format: The stream URL should contain the showId and episode number
$testCases = @(
    # ===== POPULAR CURRENT SHOWS =====
    @{ 
        Name = "Solo Leveling S1E1"
        Id = "tt21209876:1:1"
        Type = "series"
        ExpectedShowId = "B6AMhLy6EQHDgYgBF"
        ExpectedEpisode = "1"
    },
    @{ 
        Name = "Solo Leveling S2E3"
        Id = "tt21209876:2:3"
        Type = "series"
        ExpectedShowId = "9NdrgcZjsp7HEJ5oK"
        ExpectedEpisode = "3"
    },
    
    # ===== MULTI-SEASON SHOWS =====
    @{ 
        Name = "MHA S1E1"
        Id = "tt5626028:1:1"
        Type = "series"
        ExpectedShowId = "gKwRaeqdMMkgmCLZw"
        ExpectedEpisode = "1"
    },
    @{ 
        Name = "MHA S3E10"
        Id = "tt5626028:3:10"
        Type = "series"
        ExpectedShowId = "9ufLY3tw89ppeMhSK"
        ExpectedEpisode = "10"
    },
    
    # ===== LONG-RUNNING (Absolute Episode Mapping) =====
    @{ 
        Name = "One Piece S22E1 (Ep 1086)"
        Id = "tt0388629:22:1"
        Type = "series"
        ExpectedShowId = $null
        ExpectedEpisode = "1086"
    },
    @{ 
        Name = "One Piece S21E1 (Ep 892)"
        Id = "tt0388629:21:1"
        Type = "series"
        ExpectedShowId = $null
        ExpectedEpisode = "892"
    },
    
    # ===== NEWER SHOWS (2023-2024) =====
    @{ 
        Name = "Frieren S1E5"
        Id = "tt22248376:1:5"
        Type = "series"
        ExpectedShowId = $null
        ExpectedEpisode = "5"
    },
    @{ 
        Name = "Dandadan S1E1"
        Id = "tt30217403:1:1"  # Correct IMDB ID (not tt27995594)
        Type = "series"
        ExpectedShowId = "iPbyFKbQWjfeDminj"
        ExpectedEpisode = "1"
    },
    @{ 
        Name = "Dandadan S1E5"
        Id = "tt30217403:1:5"
        Type = "series"
        ExpectedShowId = "iPbyFKbQWjfeDminj"
        ExpectedEpisode = "5"
    },
    @{ 
        Name = "Blue Lock S1E10"
        Id = "tt13706018:1:10"
        Type = "series"
        ExpectedShowId = $null
        ExpectedEpisode = "10"
    },
    @{ 
        Name = "Demon Slayer S1E19"
        Id = "tt9335498:1:19"
        Type = "series"
        ExpectedShowId = "gvwLtiYciaenJRoFy"  # Direct mapping
        ExpectedEpisode = "19"
    },
    @{ 
        Name = "Demon Slayer S1E26"
        Id = "tt9335498:1:26"
        Type = "series"
        ExpectedShowId = "gvwLtiYciaenJRoFy"
        ExpectedEpisode = "26"
    },
    @{ 
        Name = "Jujutsu Kaisen S1E5"
        Id = "tt12343534:1:5"
        Type = "series"
        ExpectedShowId = "8Ti9Lnd3gW7TgeCXj"  # Direct mapping
        ExpectedEpisode = "5"
    },
    
    # ===== CLASSIC/OLDER SHOWS =====
    @{ 
        Name = "Death Note S1E1"
        Id = "tt0877057:1:1"
        Type = "series"
        ExpectedShowId = $null
        ExpectedEpisode = "1"
    },
    @{ 
        Name = "Death Note S1E25"
        Id = "tt0877057:1:25"
        Type = "series"
        ExpectedShowId = $null
        ExpectedEpisode = "25"
    },
    @{ 
        Name = "Fullmetal Alchemist Brotherhood S1E1"
        Id = "tt1355642:1:1"
        Type = "series"
        ExpectedShowId = $null
        ExpectedEpisode = "1"
    },
    @{ 
        Name = "Steins;Gate S1E12"
        Id = "tt1910272:1:12"
        Type = "series"
        ExpectedShowId = $null
        ExpectedEpisode = "12"
    },
    @{ 
        Name = "Code Geass S1E1"
        Id = "tt0994314:1:1"
        Type = "series"
        ExpectedShowId = $null
        ExpectedEpisode = "1"
    },
    @{ 
        Name = "Cowboy Bebop S1E5"
        Id = "tt0213338:1:5"
        Type = "series"
        ExpectedShowId = $null
        ExpectedEpisode = "5"
    },
    
    # ===== ANIME MOVIES =====
    @{ 
        Name = "Spirited Away (Movie)"
        Id = "tt0245429"
        Type = "movie"
        ExpectedShowId = $null
        ExpectedEpisode = "1"
    },
    @{ 
        Name = "Your Name (Movie)"
        Id = "tt5311514"
        Type = "movie"
        ExpectedShowId = $null
        ExpectedEpisode = "1"
    },
    @{ 
        Name = "Demon Slayer: Mugen Train (Movie)"
        Id = "tt11032374"
        Type = "movie"
        ExpectedShowId = $null
        ExpectedEpisode = "1"
    },
    @{ 
        Name = "Princess Mononoke (Movie)"
        Id = "tt0119698"
        Type = "movie"
        ExpectedShowId = $null
        ExpectedEpisode = "1"
    },
    @{ 
        Name = "Jujutsu Kaisen 0 (Movie)"
        Id = "tt14331144"
        Type = "movie"
        ExpectedShowId = $null
        ExpectedEpisode = "1"
    }
)

$passed = 0
$failed = 0
$results = @()

foreach ($test in $testCases) {
    # Use Type field for URL, default to series
    $contentType = if ($test.Type) { $test.Type } else { "series" }
    $url = "$BaseUrl/stream/$contentType/$($test.Id).json"
    
    Write-Host "Testing: $($test.Name)" -ForegroundColor Yellow -NoNewline
    Write-Host " [$($test.Id)]" -ForegroundColor DarkGray
    
    try {
        $response = Invoke-RestMethod -Uri $url -Method GET -TimeoutSec 30
        $streamCount = $response.streams.Count
        
        if ($streamCount -eq 0) {
            Write-Host "  [FAIL]" -ForegroundColor Red -NoNewline
            Write-Host " - No streams returned" -ForegroundColor DarkGray
            $failed++
            $results += @{ Test = $test.Name; Status = "FAIL"; Reason = "No streams" }
            continue
        }
        
        # Get the first stream URL to verify
        $streamUrl = $response.streams[0].url
        
        # Decode the URL if it's proxied
        if ($streamUrl -match "/proxy/(.+)$") {
            $streamUrl = [System.Web.HttpUtility]::UrlDecode($Matches[1])
        }
        
        Write-Host "    URL: $streamUrl" -ForegroundColor DarkGray
        
        # Extract episode number from URL (format: .../showId/sub/EPISODE or .../showId/dub/EPISODE)
        $episodeMatch = $null
        $showIdMatch = $null
        
        if ($streamUrl -match "/videos/([^/]+)/(sub|dub)/(\d+)") {
            $showIdMatch = $Matches[1]
            $episodeMatch = $Matches[3]
        }
        
        $episodeCorrect = $false
        $showIdCorrect = $false
        
        # Verify episode number
        if ($episodeMatch -eq $test.ExpectedEpisode) {
            $episodeCorrect = $true
        }
        
        # Verify show ID if expected
        if ($null -eq $test.ExpectedShowId) {
            $showIdCorrect = $true  # Not checking show ID
        } elseif ($showIdMatch -eq $test.ExpectedShowId) {
            $showIdCorrect = $true
        }
        
        if ($episodeCorrect -and $showIdCorrect) {
            Write-Host "  [PASS]" -ForegroundColor Green -NoNewline
            Write-Host " - Episode $episodeMatch" -NoNewline -ForegroundColor DarkCyan
            if ($test.ExpectedShowId) {
                Write-Host " (ShowID: $showIdMatch)" -ForegroundColor DarkCyan
            } else {
                Write-Host "" 
            }
            $passed++
            $results += @{ Test = $test.Name; Status = "PASS" }
        } else {
            Write-Host "  [FAIL]" -ForegroundColor Red
            if (-not $episodeCorrect) {
                Write-Host "    Episode MISMATCH: Got '$episodeMatch', expected '$($test.ExpectedEpisode)'" -ForegroundColor Red
            }
            if (-not $showIdCorrect) {
                Write-Host "    ShowID MISMATCH: Got '$showIdMatch', expected '$($test.ExpectedShowId)'" -ForegroundColor Red
            }
            $failed++
            $results += @{ Test = $test.Name; Status = "FAIL"; Reason = "Wrong episode/show" }
        }
    }
    catch {
        Write-Host "  [ERROR]" -ForegroundColor Red -NoNewline
        Write-Host " - $($_.Exception.Message)" -ForegroundColor DarkGray
        $failed++
        $results += @{ Test = $test.Name; Status = "ERROR" }
    }
    
    Start-Sleep -Milliseconds 300
}

# Summary
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   Episode Verification Results" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$totalTests = $testCases.Count
$passRate = [math]::Round(($passed / $totalTests) * 100, 1)

Write-Host ""
Write-Host "Total Tests: $totalTests" -ForegroundColor White
Write-Host "Passed: $passed" -ForegroundColor Green

if ($failed -gt 0) {
    Write-Host "Failed: $failed" -ForegroundColor Red
} else {
    Write-Host "Failed: $failed" -ForegroundColor Green
}

if ($passRate -ge 90) {
    Write-Host "Pass Rate: $passRate%" -ForegroundColor Green
} elseif ($passRate -ge 70) {
    Write-Host "Pass Rate: $passRate%" -ForegroundColor Yellow
} else {
    Write-Host "Pass Rate: $passRate%" -ForegroundColor Red
}

if ($failed -gt 0) {
    Write-Host ""
    Write-Host "Failed Tests:" -ForegroundColor Red
    $results | Where-Object { $_.Status -eq "FAIL" -or $_.Status -eq "ERROR" } | ForEach-Object {
        Write-Host "  - $($_.Test): $($_.Reason)" -ForegroundColor Red
    }
}

Write-Host ""
