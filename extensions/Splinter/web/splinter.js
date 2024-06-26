// Splinter - patch review add-on for Bugzilla
// By Owen Taylor <otaylor@fishsoup.net>
// Copyright 2009, Red Hat, Inc.
// Licensed under MPL 1.1 or later, or GPL 2 or later
// http://git.fishsoup.net/cgit/splinter

const Splinter = {};

Splinter.domCache = {
    cache   : [0],
    expando : 'data' + new Date(),
    data    : function (elem) {
        var cacheIndex = elem[Splinter.domCache.expando];
        var nextCacheIndex = Splinter.domCache.cache.length;
        if (!cacheIndex) {
            cacheIndex = elem[Splinter.domCache.expando] = nextCacheIndex;
            Splinter.domCache.cache[cacheIndex] = {};
        }
        return Splinter.domCache.cache[cacheIndex];
    }
};

Splinter.Utils = {
    assert : function(condition) {
        if (!condition) {
            throw new Error("Assertion failed");
        }
    },

    assertNotReached : function() {
        throw new Error("Assertion failed: should not be reached");
    },

    strip : function(string) {
        return (/^\s*([\s\S]*?)\s*$/).exec(string)[1];
    },

    lstrip : function(string) {
        return (/^\s*([\s\S]*)$/).exec(string)[1];
    },

    rstrip : function(string) {
        return (/^([\s\S]*?)\s*$/).exec(string)[1];
    },

    formatDate : function(date, now) {
        if (now == null) {
            now = new Date();
        }
        var daysAgo = (now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000);
        if (daysAgo < 0 && now.getDate() != date.getDate()) {
            return date.toLocaleDateString();
        } else if (daysAgo < 1 && now.getDate() == date.getDate()) {
            return date.toLocaleTimeString();
        } else if (daysAgo < 7 && now.getDay() != date.getDay()) {
            return ['Sun', 'Mon','Tue','Wed','Thu','Fri','Sat'][date.getDay()] + " " + date.toLocaleTimeString();
        } else {
            return date.toLocaleDateString();
        }
    },

    preWrapLines : function(el, text) {
        while ((m = Splinter.LINE_RE.exec(text)) != null) {
            var div = document.createElement("div");
            div.className = "pre-wrap";
            div.appendChild(document.createTextNode(m[1].length == 0 ? " " : m[1]));
            el.appendChild(div);
        }
    },

    isDigits : function (str) {
        return str.match(/^[0-9]+$/);
    }
};

Splinter.Bug = {
    TIMEZONES : {
        CEST: '200',
        CET:  '100',
        BST:  '100',
        GMT:  '000',
        UTC:  '000',
        EDT:  '-400',
        EST:  '-500',
        CDT:  '-500',
        CST:  '-600',
        MDT:  '-600',
        MST:  '-700',
        PDT:  '-700',
        PST:  '-800'
    },

    parseDate : function(d) {
        var m = /^\s*(\d+)-(\d+)-(\d+)\s+(\d+):(\d+)(?::(\d+))?\s+(?:([A-Z]{3,})|([-+]\d{3,}))\s*$/.exec(d);
        if (!m) {
            return null;
        }

        var year = parseInt(m[1], 10);
        var month = parseInt(m[2] - 1, 10);
        var day = parseInt(m[3], 10);
        var hour = parseInt(m[4], 10);
        var minute = parseInt(m[5], 10);
        var second = m[6] ? parseInt(m[6], 10) : 0;

        var tzoffset = 0;
        if (m[7]) {
            if (m[7] in Splinter.Bug.TIMEZONES) {
                tzoffset = Splinter.Bug.TIMEZONES[m[7]];
            }
        } else {
            tzoffset = parseInt(m[8], 10);
        }

        var unadjustedDate = new Date(Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5]));

        // 430 => 4:30. Easier to do this computation for only positive offsets
        var sign = tzoffset < 0 ? -1 : 1;
        tzoffset *= sign;
        var adjustmentHours = Math.floor(tzoffset/100);
        var adjustmentMinutes = tzoffset - adjustmentHours * 100;

        return new Date(unadjustedDate.getTime() -
                        sign * adjustmentHours * 3600000 -
                        sign * adjustmentMinutes * 60000);
    },

    _formatWho : function(name, email) {
        if (name && email) {
            return name + " <" + email + ">";
        } else if (name) {
            return name;
        } else {
            return email;
        }
    }
};

Splinter.Bug.Attachment = function(bug, id) {
    this._init(bug, id);
};

Splinter.Bug.Attachment.prototype = {
    _init : function(bug, id) {
            this.bug = bug;
            this.id = id;
    }
};

Splinter.Bug.Comment = function(bug) {
    this._init(bug);
};

Splinter.Bug.Comment.prototype = {
    _init : function(bug) {
        this.bug = bug;
    },

    getWho : function() {
        return Splinter.Bug._formatWho(this.whoName, this.whoEmail);
    }
};

Splinter.Bug.Bug = function() {
    this._init();
};

Splinter.Bug.Bug.prototype = {
    _init : function() {
        this.attachments = [];
        this.comments = [];
    },

    getAttachment : function(attachmentId) {
        var i;
        for (i = 0; i < this.attachments.length; i++) {
            if (this.attachments[i].id == attachmentId) {
                return this.attachments[i];
            }
        }
        return null;
    },

    getReporter : function() {
        return Splinter.Bug._formatWho(this.reporterName, this.reporterEmail);
    }
};

Splinter.Patch = {
    ADDED         : 1 << 0,
    REMOVED       : 1 << 1,
    CHANGED       : 1 << 2,
    NEW_NONEWLINE : 1 << 3,
    OLD_NONEWLINE : 1 << 4,

    FILE_START_RE : new RegExp(
        '^(?:' +                                    // start of optional header
        '(?:Index|index|===|RCS|diff)[^\\n]*\\n' +  // header
        '(?:(?:copy|rename) from [^\\n]+\\n)?' +    // git copy/rename from
        '(?:(?:copy|rename) to [^\\n]+\\n)?' +      // git copy/rename to
        ')*' +                                      // end of optional header
        '\\-\\-\\-[ \\t]*(\\S+).*\\n' +             // --- line
        '\\+\\+\\+[ \\t]*(\\S+).*\\n' +             // +++ line
        '(?=@@)',                                   // @@ line
        'mg'
    ),
    HUNK_START1_RE: /^@@[ \t]+-(\d+),(\d+)[ \t]+\+(\d+),(\d+)[ \t]+@@(.*)\n/mg, // -l,s +l,s
    HUNK_START2_RE: /^@@[ \t]+-(\d+),(\d+)[ \t]+\+(\d+)[ \t]+@@(.*)\n/mg,       // -l,s +l
    HUNK_START3_RE: /^@@[ \t]+-(\d+)[ \t]+\+(\d+),(\d+)[ \t]+@@(.*)\n/mg,       // -l +l,s
    HUNK_START4_RE: /^@@[ \t]+-(\d+)[ \t]+\+(\d+)[ \t]+@@(.*)\n/mg,             // -l +l
    HUNK_RE       : /((?:(?!--- )[ +\\-].*(?:\n|$)|(?:\n|$))*)/mg,

    GIT_BINARY_RE : /^diff --git a\/(\S+).*\n(?:(new|deleted) file mode \d+\n)?(?:index.*\n)?GIT binary patch\n(delta )?/mg,

    _cleanIntro : function(intro) {
        var m;

        intro = Splinter.Utils.strip(intro) + "\n\n";

        // Git: remove binary diffs
        var binary_re = /^(?:diff --git .*\n|literal \d+\n)(?:.+\n)+\n/mg;
        m = binary_re.exec(intro);
        while (m) {
            intro = intro.substr(m.index + m[0].length);
            binary_re.lastIndex = 0;
            m = binary_re.exec(intro);
        }

        // Git: remove leading 'From <commit_id> <date>'
        m = /^From\s+[a-f0-9]{40}.*\n/.exec(intro);
        if (m) {
            intro = intro.substr(m.index + m[0].length);
        }

        // Git: remove 'diff --stat' output from the end
        m = /^---\n(?:^\s.*\n)+\s+\d+\s+files changed.*\n?(?!.)/m.exec(intro);
        if (m) {
            intro = intro.substr(0, m.index);
        }

        return Splinter.Utils.strip(intro);
    }
};

Splinter.Patch.Hunk = function(oldStart, oldCount, newStart, newCount, functionLine, text) {
    this._init(oldStart, oldCount, newStart, newCount, functionLine, text);
};

Splinter.Patch.Hunk.prototype = {
    _init : function(oldStart, oldCount, newStart, newCount, functionLine, text) {
        var rawlines = text.split("\n");
        if (rawlines.length > 0 && Splinter.Utils.strip(rawlines[rawlines.length - 1]) == "") {
            rawlines.pop(); // Remove trailing element from final \n
        }

        this.oldStart = oldStart;
        this.oldCount = oldCount;
        this.newStart = newStart;
        this.newCount = newCount;
        this.functionLine = Splinter.Utils.strip(functionLine);
        this.comment = null;

        var lines = [];
        var totalOld = 0;
        var totalNew = 0;

        var currentStart = -1;
        var currentOldCount = 0;
        var currentNewCount = 0;

        // A segment is a series of lines added/removed/changed with no intervening
        // unchanged lines. We make the classification of Patch.ADDED/Patch.REMOVED/Patch.CHANGED
        // in the flags for the entire segment
        function startSegment() {
            if (currentStart < 0) {
                currentStart = lines.length;
            }
        }

        function endSegment() {
            if (currentStart >= 0) {
                if (currentOldCount > 0 && currentNewCount > 0) {
                    var j;
                    for (j = currentStart; j < lines.length; j++) {
                        lines[j][2] &= ~(Splinter.Patch.ADDED | Splinter.Patch.REMOVED);
                        lines[j][2] |= Splinter.Patch.CHANGED;
                    }
                }

                currentStart = -1;
                currentOldCount = 0;
                currentNewCount = 0;
            }
        }

        var i;
        for (i = 0; i < rawlines.length; i++) {
            var line = rawlines[i];
            var op = line.substr(0, 1);
            var strippedLine = line.substring(1);
            var noNewLine = 0;
            if (i + 1 < rawlines.length && rawlines[i + 1].substr(0, 1) == '\\') {
                noNewLine = op == '-' ? Splinter.Patch.OLD_NONEWLINE : Splinter.Patch.NEW_NONEWLINE;
            }

            if (op == ' ') {
                endSegment();
                totalOld++;
                totalNew++;
                lines.push([strippedLine, strippedLine, 0]);
            } else if (op == '-') {
                totalOld++;
                startSegment();
                lines.push([strippedLine, null, Splinter.Patch.REMOVED | noNewLine]);
                currentOldCount++;
            } else if (op == '+') {
                totalNew++;
                startSegment();
                if (currentStart + currentNewCount >= lines.length) {
                    lines.push([null, strippedLine, Splinter.Patch.ADDED | noNewLine]);
                } else {
                    lines[currentStart + currentNewCount][1] = strippedLine;
                    lines[currentStart + currentNewCount][2] |= Splinter.Patch.ADDED | noNewLine;
                }
                currentNewCount++;
            }
        }

        // git mail-formatted patches end with --\n<git version> like a signature
        // This is troublesome since it looks like a subtraction at the end
        // of last hunk of the last file. Handle this specifically rather than
        // generically stripping excess lines to be kind to hand-edited patches
        if (totalOld > oldCount &&
            lines[lines.length - 1][1] == null &&
            lines[lines.length - 1][0].substr(0, 1) == '-')
        {
            lines.pop();
            currentOldCount--;
            if (currentOldCount == 0 && currentNewCount == 0) {
                currentStart = -1;
            }
        }

        endSegment();

        this.lines = lines;
    },

    iterate : function(cb) {
        var i;
        var oldLine = this.oldStart;
        var newLine = this.newStart;
        for (i = 0; i < this.lines.length; i++) {
            var line = this.lines[i];
            cb(this.location + i, oldLine, line[0], newLine, line[1], line[2], line);
            if (line[0] != null) {
                oldLine++;
            }
            if (line[1] != null) {
                newLine++;
            }
        }
    }
};

Splinter.Patch.File = function(filename, status, extra, hunks) {
    this._init(filename, status, extra, hunks);
};

Splinter.Patch.File.prototype = {
    _init : function(filename, status, extra, hunks) {
        this.filename = filename;
        this.status = status;
        this.extra = extra;
        this.hunks = hunks;
        this.fileReviewed = false;

        var l = 0;
        var i;
        for (i = 0; i < this.hunks.length; i++) {
            var hunk = this.hunks[i];
            hunk.location = l;
            l += hunk.lines.length;
        }
    },

    // A "location" is just a linear index into the lines of the patch in this file
    getLocation : function(oldLine, newLine) {
        var i;
        for (i = 0; i < this.hunks.length; i++) {
            var hunk = this.hunks[i];
            if (oldLine != null && hunk.oldStart > oldLine) {
                continue;
            }
            if (newLine != null && hunk.newStart > newLine) {
                continue;
            }

            if ((oldLine != null && oldLine < hunk.oldStart + hunk.oldCount) ||
                (newLine != null && newLine < hunk.newStart + hunk.newCount))
            {
                var location = -1;
                hunk.iterate(function(loc, oldl, oldText, newl, newText, flags) {
                    if ((oldLine == null || oldl == oldLine) &&
                        (newLine == null || newl == newLine))
                    {
                        location = loc;
                    }
                });

                if (location != -1) {
                    return location;
                }
            }
        }

        throw "Bad oldLine,newLine: " + oldLine + "," + newLine;
    },

    getHunk : function(location) {
        var i;
        for (i = 0; i < this.hunks.length; i++) {
            var hunk = this.hunks[i];
            if (location >= hunk.location && location < hunk.location + hunk.lines.length) {
                return hunk;
            }
        }

        throw "Bad location: " + location;
    },

    toString : function() {
        return "Splinter.Patch.File(" + this.filename + ")";
    }
};

Splinter.Patch.Patch = function(text) {
    this._init(text);
};

Splinter.Patch.Patch.prototype = {
    // cf. parsing in Review.Review.parse()
    _init : function(text) {
        // Canonicalize newlines to simplify the following
        if (/\r/.test(text)) {
            text = text.replace(/(\r\n|\r|\n)/g, "\n");
        }

        this.files = [];

        var m = Splinter.Patch.FILE_START_RE.exec(text);
        var bm = Splinter.Patch.GIT_BINARY_RE.exec(text);
        if (m == null && bm == null)
            throw "Not a patch";
        this.intro = m == null ? '' : Splinter.Patch._cleanIntro(text.substring(0, m.index));

        // show binary files in the intro

        if (bm && this.intro.length)
            this.intro += "\n\n";
        while (bm != null) {
            if (bm[2]) {
                // added or deleted file
                this.intro += bm[2].charAt(0).toUpperCase() + bm[2].slice(1) + ' Binary File: ' + bm[1] + "\n";
            } else {
                // delta
                this.intro += 'Modified Binary File: ' + bm[1] + "\n";
            }
            bm = Splinter.Patch.GIT_BINARY_RE.exec(text);
        }

        while (m != null) {
            // git shows a diff between a/foo/bar.c and b/foo/bar.c or between
            // a/foo/bar.c and /dev/null for removals and the reverse for
            // additions.
            var filename;
            var status = undefined;
            var extra = undefined;

            if (/^a\//.test(m[1]) && /^b\//.test(m[2])) {
                filename = m[2].substring(2);
                status = Splinter.Patch.CHANGED;
            } else if (/^a\//.test(m[1]) && /^\/dev\/null/.test(m[2])) {
                filename = m[1].substring(2);
                status = Splinter.Patch.REMOVED;
            } else if (/^\/dev\/null/.test(m[1]) && /^b\//.test(m[2])) {
                filename = m[2].substring(2);
                status = Splinter.Patch.ADDED;
            // Handle non-git cases as well
            } else if (!/^\/dev\/null/.test(m[1]) && /^\/dev\/null/.test(m[2])) {
                filename = m[1];
                status = Splinter.Patch.REMOVED;
            } else if (/^\/dev\/null/.test(m[1]) && !/^\/dev\/null/.test(m[2])) {
                filename = m[2];
                status = Splinter.Patch.ADDED;
            } else {
                filename = m[1];
            }

            // look for rename/copy
            if (/^diff /.test(m[0])) {
                // possibly git
                var lines = m[0].split(/\n/);
                for (var i = 0, il = lines.length; i < il && !extra; i++) {
                    var line = lines[i];
                    if (line != '' && !/^(?:diff|---|\+\+\+) /.test(line)) {
                        if (/^copy from /.test(line))
                            extra = 'copied from ' + m[1].substring(2);
                        if (/^rename from /.test(line))
                            extra = 'renamed from ' + m[1].substring(2);
                    }
                }
            } else if (/^=== renamed /.test(m[0])) {
                // bzr
                filename = m[2];
                extra = 'renamed from ' + m[1];
            }

            var hunks = [];
            var pos = Splinter.Patch.FILE_START_RE.lastIndex;
            while (true) {
                var found = false;
                var oldStart, oldCount, newStart, newCount, context;

                // -l,s +l,s
                var re = Splinter.Patch.HUNK_START1_RE;
                re.lastIndex = pos;
                var m2 = re.exec(text);
                if (m2 != null && m2.index == pos) {
                    oldStart = parseInt(m2[1], 10);
                    oldCount = parseInt(m2[2], 10);
                    newStart = parseInt(m2[3], 10);
                    newCount = parseInt(m2[4], 10);
                    context  = m2[5];
                    found    = true;
                }

                if (!found) {
                    // -l,s +l
                    re = Splinter.Patch.HUNK_START2_RE;
                    re.lastIndex = pos;
                    m2 = re.exec(text);
                    if (m2 != null && m2.index == pos) {
                        oldStart = parseInt(m2[1], 10);
                        oldCount = parseInt(m2[2], 10);
                        newStart = parseInt(m2[3], 10);
                        newCount = 1;
                        context  = m2[4];
                        found    = true;
                    }
                }

                if (!found) {
                    // -l +l,s
                    re = Splinter.Patch.HUNK_START3_RE;
                    re.lastIndex = pos;
                    m2 = re.exec(text);
                    if (m2 != null && m2.index == pos) {
                        oldStart = parseInt(m2[1], 10);
                        oldCount = 1;
                        newStart = parseInt(m2[2], 10);
                        newCount = parseInt(m2[3], 10);
                        context  = m2[4];
                        found    = true;
                    }
                }

                if (!found) {
                    // -l +l
                    re = Splinter.Patch.HUNK_START4_RE;
                    re.lastIndex = pos;
                    m2 = re.exec(text);
                    if (m2 != null && m2.index == pos) {
                        oldStart = parseInt(m2[1], 10);
                        oldCount = 1;
                        newStart = parseInt(m2[2], 10);
                        newCount = 1;
                        context  = m2[3];
                        found    = true;
                    }
                }

                if (!found)
                    break;

                pos = re.lastIndex;
                Splinter.Patch.HUNK_RE.lastIndex = pos;
                var m3 = Splinter.Patch.HUNK_RE.exec(text);
                if (m3 == null || m3.index != pos) {
                    break;
                }

                pos = Splinter.Patch.HUNK_RE.lastIndex;
                hunks.push(new Splinter.Patch.Hunk(oldStart, oldCount, newStart, newCount, context, m3[1]));
            }

            if (status === undefined) {
                // For non-Git we use assume patch was generated non-zero
                // context and just look at the patch to detect added/removed.
                // Bzr actually says added/removed in the diff, but SVN/CVS
                // don't
                if (hunks.length == 1 && hunks[0].oldCount == 0) {
                    status = Splinter.Patch.ADDED;
                } else if (hunks.length == 1 && hunks[0].newCount == 0) {
                    status = Splinter.Patch.REMOVED;
                } else {
                    status = Splinter.Patch.CHANGED;
                }
            }

            this.files.push(new Splinter.Patch.File(filename, status, extra, hunks));

            Splinter.Patch.FILE_START_RE.lastIndex = pos;
            m = Splinter.Patch.FILE_START_RE.exec(text);
        }
    },

    getFile : function(filename) {
        var i;
        for (i = 0; i < this.files.length; i++) {
            if (this.files[i].filename == filename) {
                return this.files[i];
            }
       }

       return null;
    }
};

Splinter.Review = {
    _removeFromArray : function(a, element) {
        var i;
        for (i = 0; i < a.length; i++) {
            if (a[i] === element) {
                a.splice(i, 1);
                return;
            }
        }
    },

    _noNewLine : function(flags, flag) {
        return ((flags & flag) != 0) ? "\n\\ No newline at end of file" : "";
    },

    _lineInSegment : function(line) {
        return (line[2] & (Splinter.Patch.ADDED | Splinter.Patch.REMOVED | Splinter.Patch.CHANGED)) != 0;
    },

    _compareSegmentLines : function(a, b) {
        var op1 = a[0];
        var op2 = b[0];
         if (op1 == op2) {
            return 0;
        } else if (op1 == ' ') {
            return -1;
        } else if (op2 == ' ') {
            return 1;
        } else {
            return op1 == '-' ? -1 : 1;
        }
    },

    FILE_START_RE : /^:::[ \t]+(\S+)[ \t]*\n/mg,
    HUNK_START_RE : /^@@[ \t]+(?:-(\d+),(\d+)[ \t]+)?(?:\+(\d+),(\d+)[ \t]+)?@@.*\n/mg,
    HUNK_RE       : /((?:(?!@@|:::).*\n?)*)/mg,
    REVIEW_RE     : /^\s*review\s+of\s+attachment\s+(\d+)\s*:\s*/i
};

Splinter.Review.Comment = function(file, location, type, comment) {
    this._init(file, location, type, comment);
};

Splinter.Review.Comment.prototype = {
    _init : function(file, location, type, comment) {
        this.file = file;
        this.type = type;
        this.location = location;
        this.comment = comment;
    },

    getHunk : function() {
        return this.file.patchFile.getHunk(this.location);
    },

    getInReplyTo : function() {
        var i;
        var hunk = this.getHunk();
        var line = hunk.lines[this.location - hunk.location];
        for (i = 0; i < line.reviewComments.length; i++) {
            var comment = line.reviewComments[i];
            if (comment === this) {
                return null;
            }
            if (comment.type == this.type) {
                return comment;
            }
        }

        return null;
    },

    remove : function() {
        var hunk = this.getHunk();
        var line = hunk.lines[this.location - hunk.location];
        Splinter.Review._removeFromArray(this.file.comments, this);
        Splinter.Review._removeFromArray(line.reviewComments, this);
    }
};

Splinter.Review.File = function(review, patchFile) {
    this._init(review, patchFile);
};

Splinter.Review.File.prototype = {
    _init : function(review, patchFile) {
        this.review = review;
        this.patchFile = patchFile;
        this.comments = [];
    },

    addComment : function(location, type, comment) {
        var hunk = this.patchFile.getHunk(location);
        var line = hunk.lines[location - hunk.location];
        comment = new Splinter.Review.Comment(this, location, type, comment);
        if (line.reviewComments == null) {
            line.reviewComments = [];
        }
        line.reviewComments.push(comment);
        var i;
        for (i = 0; i <= this.comments.length; i++) {
            if (i == this.comments.length ||
                this.comments[i].location > location ||
                (this.comments[i].location == location && this.comments[i].type > type)) {
                this.comments.splice(i, 0, comment);
                break;
            } else if (this.comments[i].location == location &&
                       this.comments[i].type == type) {
                throw "Two comments at the same location";
            }
        }

        return comment;
    },

    getComment : function(location, type) {
        var i;
        for (i = 0; i < this.comments.length; i++) {
            if (this.comments[i].location == location &&
                this.comments[i].type == type)
            {
                return this.comments[i];
            }
        }

        return null;
    },

    toString : function() {
        var str = "::: " + this.patchFile.filename + "\n";
        var first = true;

        var i;
        for (i = 0; i < this.comments.length; i++) {
            if (first) {
                first = false;
            } else {
                str += '\n';
            }
            var comment = this.comments[i];
            var hunk = comment.getHunk();

            // Find the range of lines we might want to show. That's everything in the
            // same segment as the commented line, plus up two two lines of non-comment
            // diff before.

            var contextFirst = comment.location - hunk.location;
            if (Splinter.Review._lineInSegment(hunk.lines[contextFirst])) {
                while (contextFirst > 0 && Splinter.Review._lineInSegment(hunk.lines[contextFirst - 1])) {
                    contextFirst--;
                }
            }

            var j;
            for (j = 0; j < 5; j++) {
                if (contextFirst > 0 && !Splinter.Review._lineInSegment(hunk.lines[contextFirst - 1])) {
                    contextFirst--;
                }
            }

            // Now get the diff lines (' ', '-', '+' for that range of lines)

            var patchOldStart = null;
            var patchNewStart = null;
            var patchOldLines = 0;
            var patchNewLines = 0;
            var unchangedLines = 0;
            var patchLines = [];

            function addOldLine(oldLine) {
                if (patchOldLines == 0) {
                    patchOldStart = oldLine;
                }
                patchOldLines++;
            }

            function addNewLine(newLine) {
                if (patchNewLines == 0) {
                    patchNewStart = newLine;
                }
                patchNewLines++;
            }

            hunk.iterate(function(loc, oldLine, oldText, newLine, newText, flags) {
                if (loc >= hunk.location + contextFirst && loc <= comment.location) {
                    if ((flags & (Splinter.Patch.ADDED | Splinter.Patch.REMOVED | Splinter.Patch.CHANGED)) == 0) {
                        patchLines.push('>  ' + oldText + Splinter.Review._noNewLine(flags, Splinter.Patch.OLD_NONEWLINE | Splinter.Patch.NEW_NONEWLINE));
                        addOldLine(oldLine);
                        addNewLine(newLine);
                        unchangedLines++;
                    } else {
                        if ((comment.type == Splinter.Patch.REMOVED
                             || comment.type == Splinter.Patch.CHANGED)
                            && oldText != null)
                        {
                            patchLines.push('> -' + oldText +
                                            Splinter.Review._noNewLine(flags, Splinter.Patch.OLD_NONEWLINE));
                            addOldLine(oldLine);
                        }
                        if ((comment.type == Splinter.Patch.ADDED
                             || comment.type == Splinter.Patch.CHANGED)
                            && newText != null)
                        {
                            patchLines.push('> +' + newText +
                                            Splinter.Review._noNewLine(flags, Splinter.Patch.NEW_NONEWLINE));
                            addNewLine(newLine);
                        }
                    }
                }
            });

            // Sort them into global order ' ', '-', '+'
            patchLines.sort(Splinter.Review._compareSegmentLines);

            // Completely blank context isn't useful so remove it; however if we are commenting
            // on blank lines at the start of a segment, we have to leave something or things break
            while (patchLines.length > 1 && patchLines[0].match(/^\s*$/)) {
                patchLines.shift();
                patchOldStart++;
                patchNewStart++;
                patchOldLines--;
                patchNewLines--;
                unchangedLines--;
            }

            if (comment.type == Splinter.Patch.CHANGED) {
                // For a CHANGED comment, we have to show the the start of the hunk - but to save
                // in length we can trim unchanged context before it

                if (patchOldLines + patchNewLines - unchangedLines > 5) {
                    var toRemove = Math.min(unchangedLines, patchOldLines + patchNewLines - unchangedLines - 5);
                    patchLines.splice(0, toRemove);
                    patchOldStart += toRemove;
                    patchNewStart += toRemove;
                    patchOldLines -= toRemove;
                    patchNewLines -= toRemove;
                    unchangedLines -= toRemove;
                }

                str += '@@ -' + patchOldStart + ',' + patchOldLines + ' +' + patchNewStart + ',' + patchNewLines + ' @@\n';

                // We will use up to 10 lines more:
                //  5 old lines or 4 old lines and a "... <N> more ... " line
                //  5 new lines or 4 new lines and a "... <N> more ... " line

                var patchRemovals = patchOldLines - unchangedLines;
                var showPatchRemovals = patchRemovals > 5 ? 4 : patchRemovals;
                var patchAdditions = patchNewLines - unchangedLines;
                var showPatchAdditions = patchAdditions > 5 ? 4 : patchAdditions;

                j = 0;
                while (j < unchangedLines + showPatchRemovals) {
                    str += "> " + patchLines[j] + "\n";
                    j++;
                }
                if (showPatchRemovals < patchRemovals) {
                    str += "> ... " + (patchRemovals - showPatchRemovals) + " more ...\n";
                    j += patchRemovals - showPatchRemovals;
                }
                while (j < unchangedLines + patchRemovals + showPatchAdditions) {
                    str += "> " + patchLines[j] + "\n";
                    j++;
                }
                if (showPatchAdditions < patchAdditions) {
                    str += "> ... " + (patchAdditions - showPatchAdditions) + " more ...\n";
                    j += patchAdditions - showPatchAdditions;
                }
            } else {
                // We limit Patch.ADDED/Patch.REMOVED comments strictly to 5 lines after the header
                if (patchOldLines + patchNewLines - unchangedLines > 5) {
                    var toRemove =  patchOldLines + patchNewLines - unchangedLines - 5;
                    patchLines.splice(0, toRemove);
                    patchOldStart += toRemove;
                    patchNewStart += toRemove;
                    patchOldLines -= toRemove;
                    patchNewLines -= toRemove;
                }

                if (comment.type == Splinter.Patch.REMOVED) {
                    str += '@@ -' + patchOldStart + ',' + patchOldLines + ' @@\n';
                } else {
                    str += '@@ +' + patchNewStart + ',' + patchNewLines + ' @@\n';
                }
                str += patchLines.join("\n") + "\n";
            }
            str += "\n" + comment.comment + "\n";
        }

        return str;
    }
};

Splinter.Review.Review = function(patch, who, date) {
    this._init(patch, who, date);
};

Splinter.Review.Review.prototype = {
    _init : function(patch, who, date) {
        this.date = null;
        this.patch = patch;
        this.who = who;
        this.date = date;
        this.intro = null;
        this.files = [];

        var i;
        for (i = 0; i < patch.files.length; i++) {
            this.files.push(new Splinter.Review.File(this, patch.files[i]));
        }
    },

    // cf. parsing in Patch.Patch._init()
    parse : function(text) {
        Splinter.Review.FILE_START_RE.lastIndex = 0;
        var m = Splinter.Review.FILE_START_RE.exec(text);

        var intro;
        if (m != null) {
            this.setIntro(text.substr(0, m.index));
        } else{
            this.setIntro(text);
            return;
        }

        while (m != null) {
            var filename = m[1];
            var file = this.getFile(filename);
            if (file == null) {
                throw "Review.Review refers to filename '" + filename + "' not in reviewed Patch.";
            }

            var pos = Splinter.Review.FILE_START_RE.lastIndex;

            while (true) {
                Splinter.Review.HUNK_START_RE.lastIndex = pos;
                var m2 = Splinter.Review.HUNK_START_RE.exec(text);
                if (m2 == null || m2.index != pos) {
                    break;
                }

                pos = Splinter.Review.HUNK_START_RE.lastIndex;

                var oldStart, oldCount, newStart, newCount;
                if (m2[1]) {
                    oldStart = parseInt(m2[1], 10);
                    oldCount = parseInt(m2[2], 10);
                } else {
                    oldStart = oldCount = null;
                }

                if (m2[3]) {
                    newStart = parseInt(m2[3], 10);
                    newCount = parseInt(m2[4], 10);
                } else {
                    newStart = newCount = null;
                }

                var type;
                if (oldStart != null && newStart != null) {
                    type = Splinter.Patch.CHANGED;
                } else if (oldStart != null) {
                    type = Splinter.Patch.REMOVED;
                } else if (newStart != null) {
                    type = Splinter.Patch.ADDED;
                } else {
                    throw "Either old or new line numbers must be given";
                }

                var oldLine = oldStart;
                var newLine = newStart;

                Splinter.Review.HUNK_RE.lastIndex = pos;
                var m3 = Splinter.Review.HUNK_RE.exec(text);
                if (m3 == null || m3.index != pos) {
                    break;
                }

                pos = Splinter.Review.HUNK_RE.lastIndex;

                var rawlines = m3[1].split("\n");
                if (rawlines.length > 0 && rawlines[rawlines.length - 1].match('^/s+$')) {
                    rawlines.pop(); // Remove trailing element from final \n
                }

                var commentText = null;

                var lastSegmentOld = 0;
                var lastSegmentNew = 0;
                var i;
                for (i = 0; i < rawlines.length; i++) {
                    var line = rawlines[i];
                    var count = 1;
                    if (i < rawlines.length - 1 && rawlines[i + 1].match(/^\.\.\. \d+\s+/)) {
                        var m3 = /^\.\.\. (\d+)\s+/.exec(rawlines[i + 1]);
                        count += parseInt(m3[1], 10);
                        i += 1;
                    }
                    // The check for /^$/ is because if Bugzilla is line-wrapping it also
                    // strips completely whitespace lines
                    if (line.match(/^>\s+/) || line.match(/^$/)) {
                        oldLine += count;
                        newLine += count;
                        lastSegmentOld = 0;
                        lastSegmentNew = 0;
                    } else if (line.match(/^(> )?-/)) {
                        oldLine += count;
                        lastSegmentOld += count;
                    } else if (line.match(/^(> )?\+/)) {
                        newLine += count;
                        lastSegmentNew += count;
                    } else if (line.match(/^\\/)) {
                        // '\ No newline at end of file' - ignore
                    } else {
                        if (console)
                            console.log("WARNING: Bad content in hunk: " + line);
                        if (line != 'NaN more ...') {
                            // Tack onto current comment even thou it's invalid
                            if (commentText == null) {
                                commentText = line;
                            } else {
                                commentText += "\n" + line;
                            }
                        }
                    }

                    if ((oldStart == null || oldLine == oldStart + oldCount) &&
                        (newStart == null || newLine == newStart + newCount))
                    {
                        commentText = rawlines.slice(i + 1).join("\n");
                        break;
                    }
                }

                if (commentText == null) {
                    if (console)
                        console.log("WARNING: No comment found in hunk");
                    commentText = "";
                }


                var location;
                try {
                    if (type == Splinter.Patch.CHANGED) {
                        if (lastSegmentOld >= lastSegmentNew) {
                            oldLine--;
                        }
                        if (lastSegmentOld <= lastSegmentNew) {
                            newLine--;
                        }
                        location = file.patchFile.getLocation(oldLine, newLine);
                    } else if (type == Splinter.Patch.REMOVED) {
                        oldLine--;
                        location = file.patchFile.getLocation(oldLine, null);
                    } else if (type == Splinter.Patch.ADDED) {
                        newLine--;
                        location = file.patchFile.getLocation(null, newLine);
                    }
                } catch(e) {
                    if (console)
                        console.error(e);
                    location = 0;
                }
                file.addComment(location, type, Splinter.Utils.strip(commentText));
            }

            Splinter.Review.FILE_START_RE.lastIndex = pos;
            m = Splinter.Review.FILE_START_RE.exec(text);
        }
    },

    setIntro : function (intro) {
        intro = Splinter.Utils.strip(intro);
        this.intro = intro != "" ? intro : null;
    },

    getFile : function (filename) {
        var i;
        for (i = 0; i < this.files.length; i++) {
            if (this.files[i].patchFile.filename == filename) {
                return this.files[i];
            }
        }

        return null;
    },

    // Making toString() serialize to our seriaization format is maybe a bit sketchy
    // But the serialization format is designed to be human readable so it works
    // pretty well.
    toString : function () {
        var str = '';
        if (this.intro != null) {
            str += Splinter.Utils.strip(this.intro);
            str += '\n';
        }

        var first = this.intro == null;
        var i;
        for (i = 0; i < this.files.length; i++) {
            var file = this.files[i];
            if (file.comments.length > 0) {
                if (first) {
                    first = false;
                } else {
                    str += '\n';
                }
                str += file.toString();
            }
        }

        return str;
    }
};

Splinter.ReviewStorage = {};

Splinter.ReviewStorage.LocalReviewStorage = function() {
    this._init();
};

Splinter.ReviewStorage.LocalReviewStorage.available = function() {
    // The try is a workaround for
    //   https://bugzilla.mozilla.org/show_bug.cgi?id=517778
    // where if cookies are disabled or set to ask, then the first attempt
    // to access the localStorage property throws a security error.
    try {
        return 'localStorage' in window && window.localStorage != null;
    } catch (e) {
        return false;
    }
};

Splinter.ReviewStorage.LocalReviewStorage.prototype = {
    _init : function() {
        var reviewInfosText = localStorage.splinterReviews;
        if (reviewInfosText == null) {
            this._reviewInfos = [];
        } else {
            this._reviewInfos = JSON.parse(reviewInfosText);
        }
    },

    listReviews : function() {
        return this._reviewInfos;
    },

    _reviewPropertyName : function(bug, attachment) {
        return 'splinterReview_' + bug.id + '_' + attachment.id;
    },

    loadDraft : function(bug, attachment, patch) {
        var propertyName = this._reviewPropertyName(bug, attachment);
        var reviewText = localStorage[propertyName];
        if (reviewText != null) {
            var review = new Splinter.Review.Review(patch);
            review.parse(reviewText);
            return review;
        } else {
            return null;
        }
    },

    _findReview : function(bug, attachment) {
        var i;
        for (i = 0 ; i < this._reviewInfos.length; i++) {
            if (this._reviewInfos[i].bugId == bug.id && this._reviewInfos[i].attachmentId == attachment.id) {
                return i;
            }
        }

        return -1;
    },

    _updateOrCreateReviewInfo : function(bug, attachment, props) {
        var reviewIndex = this._findReview(bug, attachment);
        var reviewInfo;

        var nowTime = Date.now();
        if (reviewIndex >= 0) {
            reviewInfo = this._reviewInfos[reviewIndex];
            this._reviewInfos.splice(reviewIndex, 1);
        } else {
            reviewInfo = {
                bugId: bug.id,
                bugShortDesc: bug.shortDesc,
                attachmentId: attachment.id,
                attachmentDescription: attachment.description,
                creationTime: nowTime
            };
        }

        reviewInfo.modificationTime = nowTime;
        for (var prop in props) {
            reviewInfo[prop] = props[prop];
        }

        this._reviewInfos.push(reviewInfo);
        localStorage.splinterReviews = JSON.stringify(this._reviewInfos);
    },

    _deleteReviewInfo : function(bug, attachment) {
        var reviewIndex = this._findReview(bug, attachment);
        if (reviewIndex >= 0) {
            this._reviewInfos.splice(reviewIndex, 1);
            localStorage.splinterReviews = JSON.stringify(this._reviewInfos);
        }
    },

    saveDraft : function(bug, attachment, review, extraProps) {
        var propertyName = this._reviewPropertyName(bug, attachment);
        if (!extraProps) {
            extraProps = {};
        }
        extraProps.isDraft = true;
        this._updateOrCreateReviewInfo(bug, attachment, extraProps);
        localStorage[propertyName] = "" + review;
    },

    deleteDraft : function(bug, attachment, review) {
        var propertyName = this._reviewPropertyName(bug, attachment);

        this._deleteReviewInfo(bug, attachment);
        delete localStorage[propertyName];
    },

    draftPublished : function(bug, attachment) {
        var propertyName = this._reviewPropertyName(bug, attachment);

        this._updateOrCreateReviewInfo(bug, attachment, { isDraft: false });
        delete localStorage[propertyName];
    }
};

Splinter.saveDraftNoticeTimeoutId = null;
Splinter.navigationLinks = {};
Splinter.reviewers = {};
Splinter.savingDraft = false;
Splinter.UPDATE_ATTACHMENT_SUCCESS = /<title>\s*Changes\s+Submitted/;
Splinter.LINE_RE = /(?!$)([^\r\n]*)(?:\r\n|\r|\n|$)/g;

Splinter.displayError = function (msg) {
    const $error = document.getElementById('error');
    const el = document.createElement('p');
    el.appendChild(document.createTextNode(msg));
    $error.appendChild(el);
    $error.style.display = 'block';
};

Splinter.publishReview = function () {
    Splinter.saveComment();
    Splinter.theReview.setIntro(document.getElementById('myComment').value);

    if (Splinter.reviewStorage) {
        Splinter.reviewStorage.draftPublished(Splinter.theBug,
                                              Splinter.theAttachment);
    }

    const publish_form = document.getElementById('publish');
    const publish_token = document.getElementById('publish_token');
    const publish_attach_id = document.getElementById('publish_attach_id');
    const publish_attach_desc = document.getElementById('publish_attach_desc');
    const publish_attach_filename = document.getElementById('publish_attach_filename');
    const publish_attach_contenttype = document.getElementById('publish_attach_contenttype');
    const publish_attach_ispatch = document.getElementById('publish_attach_ispatch');
    const publish_attach_isobsolete = document.getElementById('publish_attach_isobsolete');
    const publish_attach_isprivate = document.getElementById('publish_attach_isprivate');
    const publish_attach_status = document.getElementById('publish_attach_status');
    const publish_review = document.getElementById('publish_review');

    publish_token.value = Splinter.theAttachment.token;
    publish_attach_id.value = Splinter.theAttachment.id;
    publish_attach_desc.value = Splinter.theAttachment.description;
    publish_attach_filename.value = Splinter.theAttachment.filename;
    publish_attach_contenttype.value = Splinter.theAttachment.contenttypeentry;
    publish_attach_ispatch.value = Splinter.theAttachment.isPatch;
    publish_attach_isobsolete.value = Splinter.theAttachment.isObsolete;
    publish_attach_isprivate.value = Splinter.theAttachment.isPrivate;

    // This is a "magic string" used to identify review comments
    if (Splinter.theReview.toString()) {
        var comment = "Review of attachment " + Splinter.theAttachment.id + ":\n" +
                      "-----------------------------------------------------------------\n\n" +
                      Splinter.theReview.toString();
        publish_review.value = comment;
    }

    const att_status = document.getElementById('attachmentStatus').value;

    if (Splinter.theAttachment.status
        && att_status != Splinter.theAttachment.status)
    {
        publish_attach_status.value = att_status;
    }

    publish_form.submit();
};

Splinter.doDiscardReview = function () {
    if (Splinter.theAttachment.status) {
        document.getElementById('attachmentStatus').value = Splinter.theAttachment.status;
    }

    document.getElementById('myComment').value = '';
    document.getElementById('emptyCommentNotice').style.display = 'block';

    var i;
    for (i = 0; i  < Splinter.theReview.files.length; i++) {
        while (Splinter.theReview.files[i].comments.length > 0) {
            Splinter.theReview.files[i].comments[0].remove();
        }
    }

    Splinter.updateMyPatchComments();
    Splinter.updateHaveDraft();
    Splinter.saveDraft();
};

Splinter.discardReview = function () {
    if (window.confirm('Really discard your changes?')) {
        Splinter.doDiscardReview();
    }
};

Splinter.haveDraft = function () {
    if (Splinter.readOnly) {
        return false;
    }

    const att_status = document.getElementById('attachmentStatus').value;

    if (Splinter.theAttachment.status && att_status != Splinter.theAttachment.status) {
        return true;
    }

    if (document.getElementById('myComment').value != '') {
        return true;
    }

    var i;
    for (i = 0; i  < Splinter.theReview.files.length; i++) {
        if (Splinter.theReview.files[i].comments.length > 0) {
            return true;
        }
    }

    for (i = 0; i  < Splinter.thePatch.files.length; i++) {
        if (Splinter.thePatch.files[i].fileReviewed) {
            return true;
        }
    }

    if (Splinter.flagChanged == 1) {
        return true;
    }

    return false;
};

Splinter.updateHaveDraft = function () {
    clearTimeout(Splinter.updateHaveDraftTimeoutId);
    Splinter.updateHaveDraftTimeoutId = null;

    if (Splinter.haveDraft()) {
        document.getElementById('publishButton').removeAttribute('disabled');
        document.getElementById('cancelButton').removeAttribute('disabled');
        document.getElementById('haveDraftNotice').style.display = 'block';
    } else {
        document.getElementById('publishButton').setAttribute('disabled', 'true');
        document.getElementById('cancelButton').setAttribute('disabled', 'true');
        document.getElementById('haveDraftNotice').style.display = 'none';
    }
};

Splinter.queueUpdateHaveDraft = function () {
    if (Splinter.updateHaveDraftTimeoutId == null) {
        Splinter.updateHaveDraftTimeoutId = setTimeout(Splinter.updateHaveDraft, 0);
    }
};

Splinter.hideSaveDraftNotice = function () {
    clearTimeout(Splinter.saveDraftNoticeTimeoutId);
    Splinter.saveDraftNoticeTimeoutId = null;
    document.getElementById('saveDraftNotice').style.display = 'none';
};

Splinter.saveDraft = function () {
    if (Splinter.reviewStorage == null) {
        return;
    }

    clearTimeout(Splinter.saveDraftTimeoutId);
    Splinter.saveDraftTimeoutId = null;

    const $notice = document.getElementById('saveDraftNotice');
    Splinter.savingDraft = true;
    Splinter.replaceText($notice, "Saving Draft...");
    $notice.style.display = 'block';
    clearTimeout(Splinter.saveDraftNoticeTimeoutId);
    setTimeout(Splinter.hideSaveDraftNotice, 3000);

    if (Splinter.currentEditComment) {
        Splinter.currentEditComment.comment
            = Splinter.Utils.strip(document.querySelector("#commentEditor textarea").value);
        // Messy, we don't want the empty comment in the saved draft, so remove it and
        // then add it back.
        if (!Splinter.currentEditComment.comment) {
            Splinter.currentEditComment.remove();
        }
    }

    Splinter.theReview.setIntro(document.getElementById('myComment').value);

    var draftSaved = false;
    if (Splinter.haveDraft()) {
        var filesReviewed = {};
        for (var i = 0; i < Splinter.thePatch.files.length; i++) {
            var file = Splinter.thePatch.files[i];
            if (file.fileReviewed) {
                filesReviewed[file.filename] = true;
            }
        }
        Splinter.reviewStorage.saveDraft(Splinter.theBug, Splinter.theAttachment, Splinter.theReview,
                                         { 'filesReviewed' : filesReviewed });
        draftSaved = true;
    } else {
        Splinter.reviewStorage.deleteDraft(Splinter.theBug, Splinter.theAttachment, Splinter.theReview);
    }

    if (Splinter.currentEditComment && !Splinter.currentEditComment.comment) {
        Splinter.currentEditComment = Splinter.currentEditComment.file.addComment(Splinter.currentEditComment.location,
                                                                                  Splinter.currentEditComment.type, "");
    }

    Splinter.savingDraft = false;
    if (draftSaved) {
        Splinter.replaceText(document.getElementById('saveDraftNotice'), "Saved Draft");
    } else {
        Splinter.hideSaveDraftNotice();
    }
};

Splinter.replaceText = function (el, text) {
    while(el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(document.createTextNode(text));
}

Splinter.queueSaveDraft = function () {
    if (Splinter.saveDraftTimeoutId == null) {
        Splinter.saveDraftTimeoutId = setTimeout(Splinter.saveDraft, 10000);
    }
};

Splinter.flushSaveDraft = function () {
    if (Splinter.saveDraftTimeoutId != null) {
        Splinter.saveDraft();
    }
};

Splinter.ensureCommentArea = function (row) {
    var file = Splinter.domCache.data(row).patchFile;
    var colSpan = file.status == Splinter.Patch.CHANGED ? 5 : 2;

    if (!row.nextSibling || row.nextSibling.className != "comment-area") {
        var tr = document.createElement('tr');
        tr.classList.add('comment-area');
        var td = document.createElement('td');
        td.setAttribute('colspan', colSpan);
        tr.appendChild(td);
        row.insertAdjacentElement('afterend', tr);
    }

    return row.nextSibling.firstChild;
};

Splinter.getTypeClass = function (type) {
    switch (type) {
    case Splinter.Patch.ADDED:
        return "comment-added";
    case Splinter.Patch.REMOVED:
        return "comment-removed";
    case Splinter.Patch.CHANGED:
        return "comment-changed";
    }

    return null;
};

Splinter.getSeparatorClass = function (type) {
    switch (type) {
    case Splinter.Patch.ADDED:
        return "comment-separator-added";
    case Splinter.Patch.REMOVED:
        return "comment-separator-removed";
    }

    return null;
};

Splinter.getReviewerClass = function (review) {
    var reviewerIndex;
    if (review == Splinter.theReview) {
        reviewerIndex = 0;
    } else {
        reviewerIndex = (Splinter.reviewers[review.who] - 1) % 5 + 1;
    }

    return "reviewer-" + reviewerIndex;
};

Splinter.addCommentDisplay = function (commentArea, comment) {
    var review = comment.file.review;

    var separatorClass = Splinter.getSeparatorClass(comment.type);
    if (separatorClass) {
        var div = document.createElement('div');
        div.classList.add(separatorClass, Splinter.getReviewerClass(review));
        commentArea.appendChild(div);
    }

    var commentDiv = document.createElement('div');
    commentDiv.classList.add('comment',
        Splinter.getTypeClass(comment.type), Splinter.getReviewerClass(review));

    commentDiv.addEventListener('dblclick', () => {
        Splinter.saveComment();
        Splinter.insertCommentEditor(commentArea, comment.file.patchFile,
                                     comment.location, comment.type);
    });

    var commentFrame = document.createElement('div');
    commentFrame.classList.add('comment-frame');
    commentDiv.appendChild(commentFrame);

    var reviewerBox = document.createElement('div');
    reviewerBox.classList.add('reviewer-box');
    commentFrame.appendChild(reviewerBox);

    var commentText = document.createElement('div');
    commentText.classList.add('comment-text');
    Splinter.Utils.preWrapLines(commentText, comment.comment);
    reviewerBox.appendChild(commentText);

    commentArea.appendChild(commentDiv);

    if (review != Splinter.theReview) {
        var reviewInfo = document.createElement('div');
        reviewInfo.classList.add('review-info');

        var reviewer = document.createElement('div');
        reviewer.classList.add('reviewer');
        reviewer.appendChild(document.createTextNode(review.who));
        reviewInfo.appendChild(reviewer);

        var reviewDate = document.createElement('div');
        reviewDate.classList.add('review-date');
        reviewDate.appendChild(document.createTextNode(Splinter.Utils.formatDate(review.date)));
        reviewInfo.appendChild(reviewDate);

        var reviewInfoBottom = document.createElement('div');
        reviewInfoBottom.classList.add('review-info-bottom');
        reviewInfo.appendChild(reviewInfoBottom);

        reviewerBox.appendChild(reviewInfo);
    }

    comment.div = commentDiv;
};

Splinter.saveComment = function () {
    var comment = Splinter.currentEditComment;
    if (!comment) {
        return;
    }

    var commentEditor = document.getElementById('commentEditor');
    var commentArea = commentEditor.parentNode;
    var reviewFile = comment.file;

    var hunk = comment.getHunk();
    var line = hunk.lines[comment.location - hunk.location];

    var value = Splinter.Utils.strip(commentEditor.getElementsByTagName('textarea')[0].value);
    if (value != "") {
        comment.comment = value;
        Splinter.addCommentDisplay(commentArea, comment);
    } else {
        comment.remove();
    }

    if (line.reviewComments.length > 0) {
        commentEditor.parentNode.removeChild(commentEditor);
        var commentEditorSeparator = document.getElementById('commentEditorSeparator');
        if (commentEditorSeparator) {
            commentEditorSeparator.parentNode.removeChild(commentEditorSeparator);
        }
    } else {
        var parentToRemove = commentArea.parentNode;
        commentArea.parentNode.parentNode.removeChild(parentToRemove);
    }

    Splinter.currentEditComment = null;
    Splinter.saveDraft();
    Splinter.queueUpdateHaveDraft();
};

Splinter.cancelComment = function (previousText) {
    document.querySelector('#commentEditor textarea').value = previousText;
    Splinter.saveComment();
};

Splinter.deleteComment = function () {
    document.querySelector('#commentEditor textarea').value = "";
    Splinter.saveComment();
};

Splinter.insertCommentEditor = function (commentArea, file, location, type) {
    Splinter.saveComment();

    var reviewFile = Splinter.theReview.getFile(file.filename);
    var comment = reviewFile.getComment(location, type);
    if (!comment) {
        comment = reviewFile.addComment(location, type, "");
        Splinter.queueUpdateHaveDraft();
    }

    var previousText = comment.comment;

    var typeClass = Splinter.getTypeClass(type);
    var separatorClass = Splinter.getSeparatorClass(type);

    commentArea.querySelectorAll('div.reviewer-0').forEach(($div) => {
        if (
            (separatorClass && $div.matches(`.${separatorClass}`))
                || $div.matches(`.${typeClass}`)
        ) {
            $div.remove();
        }
    });

    if (separatorClass) {
        var commentEditorSeparator = document.createElement('div');
        commentEditorSeparator.setAttribute('id', 'commentEditorSeparator');
        commentEditorSeparator.classList.add(separatorClass);
        commentArea.appendChild(commentEditorSeparator);
    }

    var commentEditor = document.createElement('div');
    commentEditor.setAttribute('id', 'commentEditor');
    commentEditor.classList.add(typeClass);
    commentArea.appendChild(commentEditor);

    var commentEditorInner = document.createElement('div');
    commentEditorInner.setAttribute('id', 'commentEditorInner');
    commentEditor.appendChild(commentEditorInner);

    var commentTextFrame = document.createElement('div');
    commentTextFrame.setAttribute('id', 'commentTextFrame');
    commentEditorInner.appendChild(commentTextFrame);

    var commentTextArea = document.createElement('textarea');
    commentTextArea.setAttribute('id', 'commentTextArea');
    commentTextArea.setAttribute('tabindex', 1);
    commentTextArea.appendChild(document.createTextNode(previousText));
    commentTextFrame.appendChild(commentTextArea);
    commentTextArea.addEventListener('keydown', (e) => {
        if (e.which == 13 && e.ctrlKey) {
            Splinter.saveComment();
        } else if (e.which == 27) {
            var comment = commentTextArea.value;
            if (previousText == comment || comment == '') {
                Splinter.cancelComment(previousText);
            }
        } else {
            Splinter.queueSaveDraft();
        }
    });
    commentTextArea.addEventListener('focusin', () => {
        commentEditor.classList.add('focused');
    });
    commentTextArea.addEventListener('focusout', () => {
        commentEditor.classList.remove('focused');
    });
    commentTextArea.focus();

    var commentEditorLeftButtons = document.createElement('div');
    commentEditorLeftButtons.setAttribute('id', 'commentEditorLeftButtons');
    commentEditorInner.appendChild(commentEditorLeftButtons);

    var commentCancel = document.createElement('input');
    commentCancel.setAttribute('id','commentCancel');
    commentCancel.setAttribute('type', 'button');
    commentCancel.setAttribute('value', 'Cancel');
    commentCancel.setAttribute('tabindex', 4);
    commentEditorLeftButtons.appendChild(commentCancel);
    commentCancel.addEventListener('click', () => {
        Splinter.cancelComment(previousText);
    });

    if (previousText) {
        var commentDelete = document.createElement('input');
        commentDelete.setAttribute('id','commentDelete');
        commentDelete.setAttribute('type', 'button');
        commentDelete.setAttribute('value', 'Delete');
        commentDelete.setAttribute('tabindex', 3);
        commentEditorLeftButtons.appendChild(commentDelete);
        commentDelete.addEventListener('click', () => {
            Splinter.deleteComment();
        });
    }

    var commentEditorRightButtons = document.createElement('div');
    commentEditorRightButtons.setAttribute('id', 'commentEditorRightButtons');
    commentEditorInner.appendChild(commentEditorRightButtons);

    var commentSave = document.createElement('input');
    commentSave.setAttribute('id','commentSave');
    commentSave.setAttribute('type', 'button');
    commentSave.setAttribute('value', 'Save');
    commentSave.setAttribute('tabindex', 2);
    commentEditorRightButtons.appendChild(commentSave);
    commentSave.addEventListener('click', () => {
        Splinter.saveComment();
    });

    var clear = document.createElement('div');
    clear.classList.add('clear');
    commentEditorInner.appendChild(clear);

    Splinter.currentEditComment = comment;
};

Splinter.insertCommentForRow = function (clickRow, clickType) {
    var file = Splinter.domCache.data(clickRow).patchFile;
    var clickLocation = Splinter.domCache.data(clickRow).patchLocation;

    var row = clickRow;
    var location = clickLocation;
    var type = clickType;

    Splinter.saveComment();
    var commentArea = Splinter.ensureCommentArea(row);
    Splinter.insertCommentEditor(commentArea, file, location, type);
};

Splinter.EL = function (element, cls, text, title) {
    var e = document.createElement(element);
    if (text != null) {
        e.appendChild(document.createTextNode(text));
    }
    if (cls) {
        e.className = cls;
    }
    if (title) {
        e.setAttribute('title', title);
    }

    return e;
};

Splinter.textTD = function (cls, text, title) {
  if (text == "") {
    return Splinter.EL("td", cls, "\u00a0", title);
  }
  var m = text.match(/^(.*?)(\s+)$/);
  if (m) {
    var td = Splinter.EL("td", cls, m[1], title);
    td.insertBefore(Splinter.EL("span", cls + " trailing-whitespace", m[2], title), null);
    return td;
  } else {
    return Splinter.EL("td", cls, text, title);
  }
}

Splinter.getElementPosition = function (element) {
    var left = element.offsetLeft;
    var top = element.offsetTop;
    var parent = element.offsetParent;
    while (parent && parent != document.body) {
        left += parent.offsetLeft;
        top += parent.offsetTop;
        parent = parent.offsetParent;
    }

    return [left, top];
};

Splinter.scrollToElement = function (element) {
    var windowHeight;
    if ('innerHeight' in window) { // Not IE
        windowHeight = window.innerHeight;
    } else { // IE
        windowHeight = document.documentElement.clientHeight;
    }
    var pos = Splinter.getElementPosition(element);
    var yCenter = pos[1] + element.offsetHeight / 2;
    window.scrollTo(0, yCenter - windowHeight / 2);
};

Splinter.onRowDblClick = function (e) {
    var file = Splinter.domCache.data(this).patchFile;
    var type;

    if (file.status == Splinter.Patch.CHANGED) {
        var pos = Splinter.getElementPosition(this);
        var delta = e.pageX - (pos[0] + this.offsetWidth/2);
        if (delta < - 20) {
            type = Splinter.Patch.REMOVED;
        } else if (delta < 20) {
            // CHANGED comments disabled due to breakage
            // type = Splinter.Patch.CHANGED;
            type = Splinter.Patch.ADDED;
        } else {
            type = Splinter.Patch.ADDED;
        }
    } else {
        type = file.status;
    }

    Splinter.insertCommentForRow(this, type);
};

Splinter.appendPatchTable = function (type, maxLine, parentDiv) {
    var fileTableContainer = document.createElement('div');
    fileTableContainer.classList.add('file-table-container');
    parentDiv.appendChild(fileTableContainer);

    var fileTable = document.createElement('table');
    fileTable.classList.add('file-table');
    fileTableContainer.appendChild(fileTable);

    var colQ = document.createElement('colgroup');
    fileTable.appendChild(colQ);

    var col1, col2;
    if (type != Splinter.Patch.ADDED) {
        col1 = document.createElement('col');
        col1.classList.add('line-number-column');
        col1.setAttribute('span', '1');
        colQ.appendChild(col1);
        col2 = document.createElement('col');
        col2.classList.add('old-column');
        col2.setAttribute('span', '1');
        colQ.appendChild(col2);
    }
    if (type == Splinter.Patch.CHANGED) {
        col1 = document.createElement('col');
        col1.classList.add('middle-column');
        col1.setAttribute('span', '1');
        colQ.appendChild(col1);
    }
    if (type != Splinter.Patch.REMOVED) {
        col1 = document.createElement('col');
        col1.classList.add('line-number-column');
        col1.setAttribute('span', '1');
        colQ.appendChild(col1);
        col2 = document.createElement('col');
        col2.classList.add('new-column');
        col2.setAttribute('span', '1');
        colQ.appendChild(col2);
    }

    if (type == Splinter.Patch.CHANGED) {
        fileTable.classList.add('file-table-changed');
    }

    if (maxLine >= 1000) {
        fileTable.classList.add("file-table-wide-numbers");
    }

    var tbody = document.createElement('tbody');
    fileTable.appendChild(tbody);

    return tbody;
};

Splinter.appendPatchHunk = function (file, hunk, tableType, includeComments, clickable, tbody, filter) {
    hunk.iterate(function(loc, oldLine, oldText, newLine, newText, flags, line) {
        if (filter && !filter(loc)) {
            return;
        }

        var tr = document.createElement("tr");

        var oldStyle = "";
        var newStyle = "";
        if ((flags & Splinter.Patch.CHANGED) != 0) {
            oldStyle = newStyle = "changed-line";
        } else if ((flags & Splinter.Patch.REMOVED) != 0) {
            oldStyle = "removed-line";
        } else if ((flags & Splinter.Patch.ADDED) != 0) {
            newStyle = "added-line";
        }

        var title = "Double click the line to add a review comment";

        if (tableType != Splinter.Patch.ADDED) {
            if (oldText != null) {
                tr.appendChild(Splinter.EL("td", "line-number old " + oldStyle, oldLine.toString(), title));
                tr.appendChild(Splinter.textTD("old-line " + oldStyle, oldText, title));
                oldLine++;
            } else {
                tr.appendChild(Splinter.EL("td", "line-number"));
                tr.appendChild(Splinter.EL("td", "old-line"));
            }
        }

        if (tableType == Splinter.Patch.CHANGED) {
            tr.appendChild(Splinter.EL("td", "line-middle"));
        }

        if (tableType != Splinter.Patch.REMOVED) {
            if (newText != null) {
                tr.appendChild(Splinter.EL("td", "line-number new " + newStyle, newLine.toString(), title));
                tr.appendChild(Splinter.textTD("new-line " + newStyle, newText, title));
                newLine++;
            } else if (tableType == Splinter.Patch.CHANGED) {
                tr.appendChild(Splinter.EL("td", "line-number"));
                tr.appendChild(Splinter.EL("td", "new-line"));
            }
        }

        if (!Splinter.readOnly && clickable) {
            Splinter.domCache.data(tr).patchFile = file;
            Splinter.domCache.data(tr).patchLocation = loc;
            tr.addEventListener('dblclick', Splinter.onRowDblClick);
        }

        tbody.appendChild(tr);

        if (includeComments && line.reviewComments != null) {
            var k;
            for (k = 0; k < line.reviewComments.length; k++) {
                 var commentArea = Splinter.ensureCommentArea(tr);
                 Splinter.addCommentDisplay(commentArea, line.reviewComments[k]);
            }
        }
    });
};

Splinter.addPatchFile = function (file) {
    var fileDiv = document.createElement('div');
    fileDiv.classList.add('file');
    document.getElementById('splinter-files').appendChild(fileDiv);
    file.div = fileDiv;

    var statusString;
    switch (file.status) {
    case Splinter.Patch.ADDED:
        statusString = " (new file)";
        break;
    case Splinter.Patch.REMOVED:
        statusString = " (removed)";
        break;
    case Splinter.Patch.CHANGED:
        statusString = "";
        break;
    }

    var fileLabel = document.createElement('div');
    fileLabel.classList.add('file-label');
    fileDiv.appendChild(fileLabel);

    var fileCollapseLink = document.createElement('a');
    fileCollapseLink.classList.add('file-label-collapse');
    fileCollapseLink.appendChild(document.createTextNode("[-]"));
    fileCollapseLink.setAttribute('href', "javascript:void(0);");
    fileCollapseLink.addEventListener("click", function() {
        Splinter.toggleCollapsed(encodeURIComponent(file.filename));
    });
    fileCollapseLink.setAttribute("title", 'Click to expand or collapse this file table');
    fileLabel.appendChild(fileCollapseLink);

    var fileLabelName = document.createElement('span');
    fileLabelName.classList.add('file-label-name');
    fileLabelName.appendChild(document.createTextNode(file.filename));
    fileLabel.appendChild(fileLabelName);

    var fileLabelStatus = document.createElement('span');
    fileLabelStatus.classList.add('file-label-status');
    fileLabelStatus.appendChild(document.createTextNode(statusString));
    fileLabel.appendChild(fileLabelStatus);

    if (!Splinter.readOnly) {
        var fileReviewed = document.createElement('span');
        fileReviewed.classList.add('file-review');
        fileReviewed.setAttribute('title', 'Indicates that a review has been completed for this file. ' +
                                           'This is for personal tracking purposes only and has no effect ' +
                                           'on the published review.');
        fileLabel.appendChild(fileReviewed);

        var fileReviewedInput = document.createElement('input');
        fileReviewedInput.setAttribute("type", "checkbox");
        fileReviewedInput.setAttribute("id", 'file-review-checkbox-' + encodeURIComponent(file.filename));
        fileReviewedInput.addEventListener("change", function() {
            Splinter.toggleFileReviewed(encodeURIComponent(file.filename));
        });

        if (file.fileReviewed) {
            fileReviewedInput.setAttribute("checked", 'true');
        }
        fileReviewed.appendChild(fileReviewedInput);

        var fileReviewedLabel = document.createElement('label');
        fileReviewedLabel.classList.add('file-review-label')
        fileReviewedLabel.setAttribute('for', 'file-review-checkbox-' + encodeURIComponent(file.filename));
        fileReviewedLabel.appendChild(document.createTextNode(' Reviewed'));
        fileReviewed.appendChild(fileReviewedLabel);
    }


    if (file.extra) {
        var extraContainer = document.createElement('div');
        extraContainer.classList.add('file-extra-container');
        var extraMargin = document.createElement('span');
        extraMargin.classList.add('file-label-collapse');
        extraMargin.appendChild(document.createTextNode('\u00a0\u00a0\u00a0'));
        extraContainer.appendChild(extraMargin);
        var extraLabel = document.createElement('span');
        extraLabel.classList.add('file-label-extra');
        extraLabel.appendChild(document.createTextNode(file.extra));
        extraContainer.appendChild(extraLabel);
        fileLabel.appendChild(extraContainer);
    }

    if (file.hunks.length == 0)
        return;

    var lastHunk = file.hunks[file.hunks.length - 1];
    var lastLine = Math.max(lastHunk.oldStart + lastHunk.oldCount - 1,
                            lastHunk.newStart + lastHunk.newCount - 1);

    var tbody = Splinter.appendPatchTable(file.status, lastLine, fileDiv);

    var i;
    for (i = 0; i  < file.hunks.length; i++) {
        var hunk = file.hunks[i];
        if (hunk.oldStart > 1) {
            var hunkHeader = Splinter.EL("tr", "hunk-header");
            tbody.appendChild(hunkHeader);
            hunkHeader.appendChild(Splinter.EL("td")); // line number column
            var hunkCell = Splinter.EL(
                "td",
                "hunk-cell",
                "Lines " + hunk.oldStart + '-' +
                    Math.max(hunk.oldStart + hunk.oldCount - 1, hunk.newStart + hunk.newCount - 1) +
                    "\u00a0\u00a0" + hunk.functionLine
            );
            hunkCell.colSpan = file.status == Splinter.Patch.CHANGED ? 4 : 1;
            hunkHeader.appendChild(hunkCell);
        }

        Splinter.appendPatchHunk(file, hunk, file.status, true, true, tbody);
    }
};

Splinter.appendReviewComment = function (comment, parentDiv) {
    var commentDiv = Splinter.EL("div", "review-patch-comment");
    commentDiv.addEventListener('click', () => {
        Splinter.showPatchFile(comment.file.patchFile);
        if (comment.file.review == Splinter.theReview) {
            // Immediately start editing the comment again
            var commentDivParent = comment.div.closest('.comment-area');
            var commentArea = commentDivParent.getElementsByTagName('td')[0];
            Splinter.insertCommentEditor(commentArea, comment.file.patchFile, comment.location, comment.type);
            Splinter.scrollToElement(document.getElementById('commentEditor'));
        } else {
            // Just scroll to the comment, don't start a reply yet
            Splinter.scrollToElement(comment.div);
        }
    });

    var inReplyTo = comment.getInReplyTo();
    if (inReplyTo) {
        var div = document.createElement('div');
        div.classList.add(Splinter.getReviewerClass(inReplyTo.file.review));
        commentDiv.appendChild(div);

        var reviewerBox = document.createElement('div');
        reviewerBox.classList.add('reviewer-box');
        Splinter.Utils.preWrapLines(reviewerBox, inReplyTo.comment);
        div.appendChild(reviewerBox);

        var reviewPatchCommentText = document.createElement('div');
        reviewPatchCommentText.classList.add('review-patch-comment-text');
        Splinter.Utils.preWrapLines(reviewPatchCommentText, comment.comment);
        commentDiv.appendChild(reviewPatchCommentText);

    } else {
        var hunk = comment.getHunk();

        var lastLine = Math.max(hunk.oldStart + hunk.oldCount- 1,
                                hunk.newStart + hunk.newCount- 1);
        var tbody = Splinter.appendPatchTable(comment.type, lastLine, commentDiv);

        Splinter.appendPatchHunk(comment.file.patchFile, hunk, comment.type, false, false, tbody,
            function(loc) {
                return (loc <= comment.location && comment.location - loc < 5);
        });

        var tr = document.createElement('tr');
        var td = document.createElement('td');
        tr.appendChild(td);
        td = document.createElement('td');
        td.classList.add('review-patch-comment-text');
        Splinter.Utils.preWrapLines(td, comment.comment);
        tr.appendChild(td);
        tbody.appendChild(tr);
    }

    parentDiv.appendChild(commentDiv);
};

Splinter.appendReviewComments = function (review, parentDiv) {
    var i;
    for (i = 0; i < review.files.length; i++) {
        var file = review.files[i];

        if (file.comments.length == 0) {
            continue;
        }

        parentDiv.appendChild(Splinter.EL("div", "review-patch-file", file.patchFile.filename));
        var firstComment = true;
        var j;
        for (j = 0; j < file.comments.length; j++) {
            if (firstComment) {
                firstComment = false;
            } else {
                parentDiv.appendChild(Splinter.EL("div", "review-patch-comment-separator"));
            }

            Splinter.appendReviewComment(file.comments[j], parentDiv);
        }
    }
};

Splinter.updateMyPatchComments = function () {
    var myPatchComments = document.getElementById('myPatchComments');
    Splinter.replaceText(myPatchComments, '');
    Splinter.appendReviewComments(Splinter.theReview, myPatchComments);
    myPatchComments.style.display = myPatchComments.children.length ? 'block' : 'none';
};

Splinter.selectNavigationLink = function (identifier) {
    document.querySelectorAll('.navigation-link').forEach(($link) => {
        $link.classList.remove('navigation-link-selected');
    });
    Splinter.navigationLinks[identifier].classList.add('navigation-link-selected');
};

Splinter.addNavigationLink = function (identifier, title, callback, selected) {
    var navigationDiv = document.getElementById('navigation');
    if (navigationDiv.children.length > 0) {
        navigationDiv.appendChild(document.createTextNode(' | '));
    }

    var navigationLink = document.createElement('a');
    navigationLink.classList.add('navigation-link');
    navigationLink.setAttribute('href', 'javascript:void(0);');
    navigationLink.setAttribute('id', 'switch-' + encodeURIComponent(identifier));
    navigationLink.setAttribute('title', identifier);
    navigationLink.appendChild(document.createTextNode(title));
    navigationDiv.appendChild(navigationLink);
    navigationLink.addEventListener('click', () => {
        if (!navigationLink.matches('.navigation-link-selected')) {
            callback();
        }
    });

    if (selected) {
        navigationLink.classList.add('navigation-link-selected');
    }

    Splinter.navigationLinks[identifier] = navigationLink;
};

Splinter.showOverview = function () {
    Splinter.selectNavigationLink('__OVERVIEW__');
    document.getElementById('overview').style.display = 'block';
    document.querySelectorAll('div.file').forEach(($file) => {
        $file.style.display = 'none';
    });
    if (!Splinter.readOnly)
        Splinter.updateMyPatchComments();
};

Splinter.showAllFiles = function () {
    Splinter.selectNavigationLink('__ALL__');
    document.getElementById('overview').style.display = 'none';
    document.getElementById('file-collapse-all').style.display = 'block';

    var i;
    for (i = 0; i < Splinter.thePatch.files.length; i++) {
        var file = Splinter.thePatch.files[i];
        if (!file.div) {
            Splinter.addPatchFile(file);
        } else {
            file.div.style.display = 'block';
        }
    }
}

Splinter.toggleCollapsed = function (filename, display) {
    filename = decodeURIComponent(filename);
    var i;
    for (i = 0; i < Splinter.thePatch.files.length; i++) {
        var file = Splinter.thePatch.files[i];
        if (!filename || filename == file.filename) {
            var fileTableContainer = file.div.getElementsByClassName('file-table-container')[0];
            var fileExtraContainer = file.div.getElementsByClassName('file-extra-container')[0];
            var fileCollapseLink = file.div.getElementsByClassName('file-label-collapse')[0];
            if (!display) {
                display = fileTableContainer.style.display === 'block' ? 'none' : 'block';
            }
            fileTableContainer.style.display = display;
            if (fileExtraContainer) {
                fileExtraContainer.style.display = display;
            }
            Splinter.replaceText(fileCollapseLink, (display == 'block' ? '[-]' : '[+]'));
        }
    }
}

Splinter.toggleFileReviewed = function (filename) {
    var checkbox = document.getElementById(`file-review-checkbox-${filename}`);
    if (checkbox) {
        filename = decodeURIComponent(filename);
        for (var i = 0; i < Splinter.thePatch.files.length; i++) {
            var file = Splinter.thePatch.files[i];
            if (file.filename == filename) {
                file.fileReviewed = checkbox.checked;

                Splinter.saveDraft();
                Splinter.queueUpdateHaveDraft();

                // Strike through file names to show review was completed
                document.getElementById(`switch-${encodeURIComponent(filename)}`).classList
                    .toggle('file-reviewed-nav', file.fileReviewed);
            }
        }
    }
}

Splinter.showPatchFile = function (file) {
    Splinter.selectNavigationLink(file.filename);
    document.getElementById('overview').style.display = 'none';
    document.getElementById('file-collapse-all').style.display = 'none';

    document.querySelectorAll('div.file').forEach(($file) => {
        $file.style.display = 'none';
    });

    if (file.div) {
        file.div.style.display = 'block';
    } else {
        Splinter.addPatchFile(file);
    }
};

Splinter.addFileNavigationLink = function (file) {
    var basename = file.filename.replace(/.*\//, "");
    Splinter.addNavigationLink(file.filename, basename, function() {
        Splinter.showPatchFile(file);
    });
};

Splinter.start = function () {
    document.getElementById('navigationContainer').style.display = 'block';
    document.getElementById('overview').style.display = 'block';
    document.getElementById('splinter-files').style.display = 'block';
    document.getElementById('attachmentStatusSpan').style.display = 'none';

    if (Splinter.thePatch.intro) {
        Splinter.Utils.preWrapLines(document.getElementById('patchIntro'), Splinter.thePatch.intro);
    } else {
        document.getElementById('patchIntro').style.display = 'none';
    }

    Splinter.addNavigationLink('__OVERVIEW__', "Overview", Splinter.showOverview, true);
    Splinter.addNavigationLink('__ALL__', "All Files", Splinter.showAllFiles, false);

    var i;
    for (i = 0; i < Splinter.thePatch.files.length; i++) {
        Splinter.addFileNavigationLink(Splinter.thePatch.files[i]);
    }

    var navigation = document.getElementById('navigation');

    var haveDraftNotice = document.createElement('div');
    haveDraftNotice.setAttribute('id', 'haveDraftNotice');
    haveDraftNotice.appendChild(document.createTextNode('Draft'));
    navigation.appendChild(haveDraftNotice);

    var clear = document.createElement('div');
    clear.classList.add('clear');
    navigation.appendChild(clear);

    var numReviewers = 0;
    for (i = 0; i < Splinter.theBug.comments.length; i++) {
        var comment = Splinter.theBug.comments[i];
        var m = Splinter.Review.REVIEW_RE.exec(comment.text);

        if (m && parseInt(m[1], 10) == Splinter.attachmentId) {
            var review = new Splinter.Review.Review(Splinter.thePatch, comment.getWho(), comment.date);
            review.parse(comment.text.substr(m[0].length));

            var reviewerIndex;
            if (review.who in Splinter.reviewers) {
                reviewerIndex = Splinter.reviewers[review.who];
            } else {
                reviewerIndex = ++numReviewers;
                Splinter.reviewers[review.who] = reviewerIndex;
            }

            var reviewDiv = document.createElement('div');
            reviewDiv.classList.add('review', Splinter.getReviewerClass(review));
            document.getElementById('oldReviews').appendChild(reviewDiv);

            var reviewerBox = document.createElement('div');
            reviewerBox.classList.add('reviewer-box');
            reviewDiv.appendChild(reviewerBox);

            var reviewer = document.createElement('div');
            reviewer.classList.add('reviewer');
            reviewer.appendChild(document.createTextNode(review.who));
            reviewerBox.appendChild(reviewer);

            var reviewDate = document.createElement('div');
            reviewDate.classList.add('review-date');
            reviewDate.appendChild(document.createTextNode(Splinter.Utils.formatDate(review.date)));
            reviewerBox.appendChild(reviewDate);

            var reviewInfoBottom = document.createElement('div');
            reviewInfoBottom.classList.add('review-info-bottom');
            reviewerBox.appendChild(reviewInfoBottom);

            var reviewIntro = document.createElement('div');
            reviewIntro.classList.add('review-intro');
            Splinter.Utils.preWrapLines(reviewIntro, review.intro? review.intro : "");
            reviewerBox.appendChild(reviewIntro);

            document.getElementById('oldReviews').style.display = 'block';

            Splinter.appendReviewComments(review, reviewerBox);
        }
    }

    // We load the saved draft or create a new review *after* inserting the existing reviews
    // so that the ordering comes out right.

    if (Splinter.reviewStorage) {
        Splinter.theReview = Splinter.reviewStorage.loadDraft(Splinter.theBug, Splinter.theAttachment, Splinter.thePatch);
        if (Splinter.theReview) {
            var storedReviews = Splinter.reviewStorage.listReviews();
            document.getElementById('restored').style.display = 'block';
            for (i = 0; i < storedReviews.length; i++) {
                if (storedReviews[i].bugId == Splinter.theBug.id &&
                    storedReviews[i].attachmentId == Splinter.theAttachment.id)
                {
                    Splinter.replaceText(
                        document.getElementById('restoredLastModified'),
                        Splinter.Utils.formatDate(new Date(storedReviews[i].modificationTime))
                    );
                    // Restore file reviewed checkboxes
                    if (storedReviews[i].filesReviewed) {
                        for (var j = 0; j < Splinter.thePatch.files.length; j++) {
                            var file = Splinter.thePatch.files[j];
                            if (storedReviews[i].filesReviewed[file.filename]) {
                                file.fileReviewed = true;
                                // Strike through file names to show that review was completed
                                document.getElementById(`switch-${encodeURIComponent(file.filename)}`)
                                    .classList.add('file-reviewed-nav');
                            }
                        }
                    }
                }
            }
        }
    }

    if (!Splinter.theReview) {
        Splinter.theReview = new Splinter.Review.Review(Splinter.thePatch);
    }

    if (Splinter.theReview.intro) {
        document.getElementById('emptyCommentNotice').style.display = 'none';
    }

    if (!Splinter.readOnly) {
        var myComment = document.getElementById('myComment');
        myComment.value = Splinter.theReview.intro ? Splinter.theReview.intro : "";
        myComment.addEventListener('focus', () => {
            document.getElementById('emptyCommentNotice').style.display = 'none';
        });
        myComment.addEventListener('blur', () => {
            if (myComment.value == '') {
                document.getElementById('emptyCommentNotice').style.display = 'block';
            }
        });
        myComment.addEventListener('keydown', () => {
            Splinter.queueSaveDraft();
            Splinter.queueUpdateHaveDraft();
        });

        Splinter.updateMyPatchComments();

        Splinter.queueUpdateHaveDraft();

        document.getElementById('publishButton').addEventListener('click', Splinter.publishReview);
        document.getElementById('cancelButton').addEventListener('click', Splinter.discardReview);
    } else {
        document.getElementById('haveDraftNotice').style.display = 'none';
    }
};

Splinter.newPageUrl = function (newBugId, newAttachmentId) {
    var newUrl = Splinter.configBase;
    if (newBugId != null) {
        newUrl += (newUrl.indexOf("?") < 0) ? "?" : "&";
        newUrl += "bug=" + escape("" + newBugId);
        if (newAttachmentId != null) {
            newUrl += "&attachment=" + escape("" + newAttachmentId);
        }
    }

    return newUrl;
};

Splinter.showNote = function () {
    var noteDiv = document.getElementById('note');
    if (noteDiv && Splinter.configNote) {
        Splinter.replaceText(noteDiv, Splinter.configNote);
        noteDiv.style.display = 'block';
    }
};

Splinter.showEnterBug = function () {
    Splinter.showNote();

    document.getElementById('enterBugGo').addEventListener('click', () => {
        var newBugId = Splinter.Utils.strip(document.getElementById("enterBugInput").value);
        document.location = Splinter.newPageUrl(newBugId);
    });

    document.getElementById('enterBug').style.display = 'block';

    if (!Splinter.reviewStorage) {
        return;
    }

    var storedReviews = Splinter.reviewStorage.listReviews();
    if (storedReviews.length == 0) {
        return;
    }

    var i;
    var reviewData = [];
    for (i = storedReviews.length - 1; i >= 0; i--) {
        var reviewInfo = storedReviews[i];
        var modificationDate = Splinter.Utils.formatDate(new Date(reviewInfo.modificationTime));
        var extra = reviewInfo.isDraft ? "(draft)" : "";

        reviewData.push({
            bug_id: reviewInfo.bugId,
            attachment_id: `${reviewInfo.bugId}:${reviewInfo.attachmentId}`,
            description: reviewInfo.attachmentDescription,
            date: modificationDate,
            extra,
        });
    }

    var attachLink = function ({ value }) {
        const [budId, attachmentId] = value.split(':', 2);
        return `<a href=\"${Splinter.newPageUrl(budId, attachmentId)}\">${attachmentId}</a>`;
    };

    var bugLink = function ({ value }) {
        return `<a href=\"${Splinter.newPageUrl(value)}\">${value}</a>`;
    };

    var attachDesc = function ({ $column, value }) {
        Splinter.replaceText($column, value);
    };

    var columnDefs = [
        { key: "bug_id", label: "Bug", formatter: bugLink, allowHTML: true },
        { key: "attachment_id", label: "Attachment", formatter: attachLink, allowHTML: true },
        { key: "description", label: "Description", formatter: attachDesc },
        { key: "date", label: "Date" },
        { key: "extra", label: "Extra" }
    ];

    new Bugzilla.DataTable({
        container: '#chooseReviewTable',
        columns: columnDefs,
        data: reviewData,
    });

    document.getElementById('chooseReview').style.display = 'block';
};

Splinter.showChooseAttachment = function () {
    var drafts = {};
    var published = {};
    if (Splinter.reviewStorage) {
        var storedReviews = Splinter.reviewStorage.listReviews();
        var j;
        for (j = 0; j < storedReviews.length; j++) {
            var reviewInfo = storedReviews[j];
            if (reviewInfo.bugId == Splinter.theBug.id) {
                if (reviewInfo.isDraft) {
                    drafts[reviewInfo.attachmentId] = 1;
                } else {
                    published[reviewInfo.attachmentId] = 1;
                }
            }
        }
    }

    var attachData = [];

    var i;
    for (i = 0; i < Splinter.theBug.attachments.length; i++) {
        var attachment = Splinter.theBug.attachments[i];
        const { id, description, date, isPatch, isObsolete } = attachment;

        if (!isPatch || isObsolete) {
            continue;
        }

        var extra = '';
        if (id in drafts) {
            extra = '(draft)';
        } else if (id in published) {
            extra = '(published)';
        }

        attachData.push({
            id,
            description,
            date: Splinter.Utils.formatDate(date),
            extra,
        });
    }

    var attachLink = function ({ value }) {
        return `<a href=\"${Splinter.newPageUrl(Splinter.theBug.id, value)}\">${value}</a>`;
    };

    var attachDesc = function ({ $column, value }) {
        Splinter.replaceText($column, value);
    };

    var columnDefs = [
        { key: "id", label: "ID", formatter: attachLink, allowHTML: true },
        { key: "description", label: "Description", formatter: attachDesc },
        { key: "date", label: "Date" },
        { key: "extra", label: "Extra" }
    ];

    new Bugzilla.DataTable({
        container: '#chooseAttachmentTable',
        columns: columnDefs,
        data: attachData,
    });

    document.getElementById('chooseAttachment').style.display = 'block';
};

Splinter.quickHelpToggle = function () {
    var quickHelpShow = document.getElementById('quickHelpShow');
    var quickHelpContent = document.getElementById('quickHelpContent');
    var quickHelpToggle = document.getElementById('quickHelpToggle');

    if (quickHelpContent.style.display == 'none') {
        quickHelpContent.style.display = 'block';
        quickHelpShow.style.display = 'none';
    } else {
        quickHelpContent.style.display = 'none';
        quickHelpShow.style.display = 'block';
    }
};

Splinter.init = function () {
    Splinter.showNote();

    if (Splinter.ReviewStorage.LocalReviewStorage.available()) {
        Splinter.reviewStorage = new Splinter.ReviewStorage.LocalReviewStorage();
    }

    if (Splinter.theBug == null) {
        Splinter.showEnterBug();
        return;
    }

    Splinter.replaceText(document.getElementById("bugId"), Splinter.theBug.id);
    document.getElementById('bugLink').setAttribute('href', `${Splinter.configBugUrl}show_bug.cgi?id=${Splinter.theBug.id}`);
    Splinter.replaceText(document.getElementById("bugShortDesc"), Splinter.theBug.shortDesc);
    Splinter.replaceText(document.getElementById("bugReporter"), Splinter.theBug.getReporter());
    Splinter.replaceText(document.getElementById("bugCreationDate"), Splinter.Utils.formatDate(Splinter.theBug.creationDate));
    document.getElementById('bugInfo').style.display = 'block';

    if (Splinter.attachmentId) {
        Splinter.theAttachment = Splinter.theBug.getAttachment(Splinter.attachmentId);

        if (Splinter.theAttachment == null) {
            Splinter.displayError("Attachment " + Splinter.attachmentId + " is not an attachment to bug " + Splinter.theBug.id);
        }
        else if (!Splinter.theAttachment.isPatch) {
            Splinter.displayError("Attachment " + Splinter.attachmentId + " is not a patch");
            Splinter.theAttachment = null;
        }
    }

    if (Splinter.theAttachment == null) {
        Splinter.showChooseAttachment();

    } else {
        Splinter.replaceText(document.getElementById("attachId"), Splinter.theAttachment.id);
        document.getElementById('attachLink').setAttribute('href', `${Splinter.configBugUrl}attachment.cgi?id=${Splinter.theAttachment.id}`);
        Splinter.replaceText(document.getElementById("attachDesc"), Splinter.theAttachment.description);
        Splinter.replaceText(document.getElementById("attachCreator"), Splinter.Bug._formatWho(Splinter.theAttachment.whoName, Splinter.theAttachment.whoEmail));
        Splinter.replaceText(document.getElementById("attachDate"), Splinter.Utils.formatDate(Splinter.theAttachment.date));
        Splinter.replaceText(document.getElementById("attachComment"), Splinter.attachmentComment);
        var warnings = [];
        if (Splinter.theAttachment.isObsolete)
            warnings.push('OBSOLETE');
        if (Splinter.theAttachment.isCRLF)
            warnings.push('WINDOWS PATCH');
        if (warnings.length > 0)
            Splinter.replaceText(document.getElementById("attachWarning"), warnings.join(', '));
        document.getElementById('attachInfo').style.display = 'block';

        document.getElementById('quickHelpShow').style.display = 'block';

        document.title = "Patch Review of Attachment " + Splinter.theAttachment.id +
                         " for Bug " + Splinter.theBug.id;

        Splinter.thePatch = new Splinter.Patch.Patch(Splinter.theAttachment.data);
        if (Splinter.thePatch != null) {
            Splinter.start();
        }
    }
};

window.addEventListener('load', () => {
    Splinter.init();
});
