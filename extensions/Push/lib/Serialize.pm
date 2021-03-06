# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# This Source Code Form is "Incompatible With Secondary Licenses", as
# defined by the Mozilla Public License, v. 2.0.

package Bugzilla::Extension::Push::Serialize;

use 5.10.1;
use strict;
use warnings;

use Bugzilla::Bug;
use Bugzilla::Constants;
use Bugzilla::Extension::Push::Util;
use Bugzilla::Version;

use Scalar::Util 'blessed';
use JSON ();

my %translated_field_names = reverse %{Bugzilla::Bug::FIELD_MAP()};
$translated_field_names{'bug_group'} = 'groups';

my $_instance;

sub instance {
  $_instance ||= Bugzilla::Extension::Push::Serialize->_new();
  return $_instance;
}

sub _new {
  my ($class) = @_;
  my $self = {};
  bless($self, $class);
  return $self;
}

# given an object, serialize to a hash
sub object_to_hash {
  my ($self, $object, $is_shallow) = @_;

  my $method = lc(blessed($object));
  $method =~ s/::/_/g;
  $method =~ s/^bugzilla//;
  return unless $self->can($method);
  (my $name = $method) =~ s/^_//;

  # check for a cached hash
  my $cache = Bugzilla->request_cache;
  my $cache_id = "push." . ($is_shallow ? 'shallow.' : 'deep.') . $object;
  if (exists($cache->{$cache_id})) {
    return wantarray ? ($cache->{$cache_id}, $name) : $cache->{$cache_id};
  }

  # call the right method to serialize to a hash
  my $rh = $self->$method($object, $is_shallow);

  # store in cache
  if ($cache_id) {
    $cache->{$cache_id} = $rh;
  }

  return wantarray ? ($rh, $name) : $rh;
}

# given a changes hash, return an event hash
sub changes_to_event {
  my ($self, $changes) = @_;

  my $event = {};

  # create common (created and modified) fields
  $event->{'user'} = $self->object_to_hash(Bugzilla->user);
  my $timestamp = $changes->{'timestamp'}
    || Bugzilla->dbh->selectrow_array('SELECT LOCALTIMESTAMP(0)');
  $event->{'time'} = datetime_to_timestamp($timestamp);

  foreach my $change (@{$changes->{'changes'}}) {
    if (exists $change->{'field'}) {

      # map undef to empty
      hash_undef_to_empty($change);

      # custom_fields change from undef to empty, ignore these changes
      return
        if ($change->{'added'} || "") eq "" && ($change->{'removed'} || "") eq "";

      # use saner field serialization
      my $field = $change->{'field'};

      # Fix field name to match other API methods
      $change->{'field'} = $translated_field_names{$field} || $field;

      if ($field eq 'priority' || $field eq 'target_milestone') {
        $change->{'added'}   = _select($change->{'added'});
        $change->{'removed'} = _select($change->{'removed'});

      }
      elsif ($field =~ /^cf_/) {
        $change->{'added'}   = _custom_field($field, $change->{'added'});
        $change->{'removed'} = _custom_field($field, $change->{'removed'});
      }

      $event->{'changes'} = [] unless exists $event->{'changes'};

      push @{$event->{'changes'}}, $change;
    }
  }

  return $event;
}

# Bugzilla returns '---' or '--' for single-select fields that have no value
# selected.  it makes more sense to return an empty string.
sub _select {
  my ($value) = @_;
  return '' if $value eq '---' or $value eq '--';
  return $value;
}

# return an object which serializes to a JSON boolean, but still acts as a Perl
# boolean
sub _boolean {
  my ($value) = @_;
  return $value ? JSON::true : JSON::false;
}

sub _string {
  my ($value) = @_;
  return defined($value) ? $value : '';
}

sub _time {
  my ($value) = @_;
  return defined($value) ? datetime_to_timestamp($value) : undef;
}

sub _integer {
  my ($value) = @_;
  return defined($value) ? $value + 0 : undef;
}

sub _array {
  my ($value) = @_;
  return defined($value) ? $value : [];
}

sub _custom_field {
  my ($field, $value) = @_;
  $field = Bugzilla::Field->new({name => $field}) unless blessed $field;

  if ($field->type == FIELD_TYPE_DATETIME) {
    return _time($value);

  }
  elsif ($field->type == FIELD_TYPE_SINGLE_SELECT) {
    return _select($value);

  }
  elsif ($field->type == FIELD_TYPE_MULTI_SELECT) {
    return _array($value);

  }
  else {
    return _string($value);
  }
}

#
# class mappings
# automatically derived from the class name
# Bugzilla::Bug --> _bug, Bugzilla::User --> _user, etc
#

sub _bug {
  my ($self, $bug) = @_;

  my $rh = {
    id                 => _integer($bug->bug_id),
    alias              => _string($bug->alias),
    assigned_to        => _string($bug->assigned_to->login),
    assigned_to_detail => $self->_user($bug->assigned_to),
    classification     => _string($bug->classification),
    component          => _string($bug->component),
    creation_time      => _time($bug->creation_ts || $bug->delta_ts),
    creator            => _string($bug->reporter->login),
    creator_detail     => $self->_user($bug->reporter),
    flags              => (mapr { $self->_flag($_) } $bug->flags),
    is_private         => _boolean(!is_public($bug)),
    keywords           => (mapr { _string($_->name) } $bug->keyword_objects),
    last_change_time   => _time($bug->delta_ts),
    operating_system   => _string($bug->op_sys),
    platform           => _string($bug->rep_platform),
    priority           => _select($bug->priority),
    product            => _string($bug->product),
    resolution         => _string($bug->resolution),
    see_also           => (mapr { _string($_->name) } $bug->see_also),
    severity           => _string($bug->bug_severity),
    status             => _string($bug->bug_status),
    summary            => _string($bug->short_desc),
    target_milestone   => _string($bug->target_milestone),
    type               => _string($bug->bug_type),
    url                => _string($bug->bug_file_loc),
    version            => _string($bug->version),
    whiteboard         => _string($bug->status_whiteboard),
  };

  if ($bug->qa_contact) {
    $rh->{qa_contact}        = $bug->qa_contact->login;
    $rh->{qa_contact_detail} = $self->_user($bug->qa_contact);
  }
  else {
    $rh->{qa_contact} = _string('');
  }

  # add custom fields
  my @custom_fields = Bugzilla->active_custom_fields(
    {product => $bug->product_obj, component => $bug->component_obj});
  foreach my $field (@custom_fields) {
    my $name = $field->name;
    $rh->{$name} = _custom_field($field, $bug->$name);
  }

  return $rh;
}

sub _user {
  my ($self, $user) = @_;
  return undef unless $user;
  return {
    id        => _integer($user->id),
    login     => _string($user->login),
    real_name => _string($user->name),
  };
}

sub _attachment {
  my ($self, $attachment, $is_shallow) = @_;
  my $rh = {
    id               => _integer($attachment->id),
    content_type     => _string($attachment->contenttype),
    creation_time    => _time($attachment->attached),
    description      => _string($attachment->description),
    file_name        => _string($attachment->filename),
    flags            => (mapr { $self->_flag($_) } $attachment->flags),
    is_obsolete      => _boolean($attachment->isobsolete),
    is_patch         => _boolean($attachment->ispatch),
    is_private       => _boolean(!is_public($attachment)),
    last_change_time => _time($attachment->modification_time),
  };
  if (!$is_shallow) {
    $rh->{bug} = $self->_bug($attachment->bug);
  }
  return $rh;
}

sub _comment {
  my ($self, $comment, $is_shallow) = @_;
  my $rh = {
    id            => _integer($comment->id),
    body          => _string($comment->body),
    creation_time => _time($comment->creation_ts),
    is_private    => _boolean($comment->is_private),
    number        => _integer($comment->count),
  };
  if (!$is_shallow) {
    $rh->{bug} = $self->_bug($comment->bug);
  }
  return $rh;
}

sub _flag {
  my ($self, $flag) = @_;
  my $rh = {
    id    => _integer($flag->id),
    name  => _string($flag->type->name),
    value => _string($flag->status),
  };
  if ($flag->requestee) {
    $rh->{'requestee'} = $self->_user($flag->requestee);
  }
  return $rh;
}

1;
