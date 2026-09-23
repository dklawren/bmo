#!/usr/bin/env perl
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# This Source Code Form is "Incompatible With Secondary Licenses", as
# defined by the Mozilla Public License, v. 2.0.

#####################################################
# Test for REST Bug.create() and Bug.update() with  #
# DATE and DATETIME custom fields                   #
# POST /rest/bug                                    #
# PUT /rest/bug/<id>                                #
#####################################################

# FIELD_TYPE_DATE custom fields must be passed through to the Bug object as
# YYYY-MM-DD. FIELD_TYPE_DATETIME custom fields must still be converted from
# ISO 8601 by the REST server before reaching the Bug object. See bug 2074690.

use 5.10.1;
use strict;
use warnings;
use lib qw(lib ../../lib ../../local/lib/perl5);

use Bugzilla;
use Bugzilla::Util qw(datetime_from);
use QA::Util qw(get_config);
use QA::Tests qw(create_bug_fields);
use QA::REST::Util qw(api_headers);

use Test::Mojo;
use Test::More;

use constant DATE_FIELD     => 'cf_qa_date';
use constant DATETIME_FIELD => 'cf_qa_datetime';

my $config  = get_config();
my $api_key = $config->{editbugs_user_api_key};
my $url     = Bugzilla->localconfig->urlbase;

my $t = Test::Mojo->new();

# The REST API always returns dates as ISO 8601 in UTC with a trailing 'Z'.
# A date-only value is stored without a time zone, so compute the expected
# output the same way the server does rather than assuming it runs in UTC.
sub expected_iso8601 {
  my ($value) = @_;
  return datetime_from($value, 'UTC')->iso8601() . 'Z';
}

sub check_bug_dates {
  my ($bug_id, $date, $datetime, $desc) = @_;
  my $fields = join(',', DATE_FIELD, DATETIME_FIELD);
  $t->get_ok(
    $url . "rest/bug/$bug_id?include_fields=$fields" => api_headers($api_key))
    ->status_is(200)
    ->json_is('/bugs/0/' . DATE_FIELD, expected_iso8601($date),
    "$desc: date field has the right value")
    ->json_is('/bugs/0/' . DATETIME_FIELD, $datetime,
    "$desc: datetime field has the right value");
}

###############################
# Create with both field types #
###############################

my $new_bug = create_bug_fields($config);
$new_bug->{+DATE_FIELD}     = '2026-01-15';
$new_bug->{+DATETIME_FIELD} = '2026-01-15T12:15:00Z';

$t->post_ok($url . 'rest/bug' => api_headers($api_key) => json => $new_bug)
  ->status_is(200)->json_has('/id');
my $bug_id = $t->tx->res->json->{id};

check_bug_dates($bug_id, '2026-01-15', '2026-01-15T12:15:00Z', 'After create');

###############################
# Update with both field types #
###############################

$t->put_ok($url
    . "rest/bug/$bug_id" => api_headers($api_key) => json =>
    {DATE_FIELD, '2026-02-20', DATETIME_FIELD, '2026-02-20T08:45:00Z'})
  ->status_is(200);

check_bug_dates($bug_id, '2026-02-20', '2026-02-20T08:45:00Z', 'After update');

#############################################
# Date fields still reject a time component #
#############################################

$t->put_ok($url
    . "rest/bug/$bug_id" => api_headers($api_key) => json =>
    {DATE_FIELD, '2026-03-01 10:00:00'})->status_is(400)
  ->json_is('/code' => 56)
  ->json_like('/message' => qr/is not a legal date/);

check_bug_dates($bug_id, '2026-02-20', '2026-02-20T08:45:00Z',
  'After rejected update');

done_testing();
