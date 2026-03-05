<?php

use BookStack\Facades\Theme;
use BookStack\Theming\ThemeEvents;

Theme::listen(ThemeEvents::APP_BOOT, function () {
    // Phase 1 scaffold: View override & assets stay behavior-compatible.
});
