# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# This Source Code Form is "Incompatible With Secondary Licenses", as
# defined by the Mozilla Public License, v. 2.0.

package Bugzilla::WebService::Server::REST::Resources::User;

use 5.10.1;
use strict;
use warnings;

use Bugzilla::WebService::Constants;
use Bugzilla::WebService::User;

BEGIN {
  *Bugzilla::WebService::User::rest_resources = \&_rest_resources;
}

sub _rest_resources {
  my $rest_resources = [
    qr{^/user/suggest$},
    {GET => {method => 'suggest',},},
    qr{^/valid_login$},
    {GET => {method => 'valid_login'}},
    qr{^/login$},
    {GET => {method => 'login'}},
    qr{^/logout$},
    {GET => {method => 'logout'}},
    qr{^/user$},
    {
      GET  => {method => 'get'},
      POST => {method => 'create', success_code => STATUS_CREATED}
    },
    qr{^/user/([^/]+)$},
    {
      GET => {
        method => 'get',
        params => sub {
          my $param = $_[0] =~ /^\d+$/ ? 'ids' : 'names';
          return {$param => [$_[0]]};
        }
      },
      PUT => {
        method => 'update',
        params => sub {
          my $param = $_[0] =~ /^\d+$/ ? 'ids' : 'names';
          return {$param => [$_[0]]};
        }
      }
    },
    qr{^/user/mfa/([^/]+)/enroll$},
    {
      GET => {
        method => 'mfa_enroll',
        params => sub {
          return {provider => $_[0]};
        }
      },
    },
    qr{^/user/mfa/verify_totp_code$},
    {
      POST => {
        method => 'mfa_verify_totp_code',
      }
    },
    qr{^/whoami$},
    {GET => {method => 'whoami'}}
  ];
  return $rest_resources;
}

1;

__END__

=head1 NAME

Bugzilla::Webservice::Server::REST::Resources::User - The User Account REST API

=head1 DESCRIPTION

This part of the Bugzilla REST API allows you to get User information as well
as create User Accounts.

See L<Bugzilla::WebService::Bug> for more details on how to use this part of
the REST API.
