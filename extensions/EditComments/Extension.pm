# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# This Source Code Form is "Incompatible With Secondary Licenses", as
# defined by the Mozilla Public License, v. 2.0.

package Bugzilla::Extension::EditComments;

use 5.10.1;
use strict;
use warnings;

use base qw(Bugzilla::Extension);

use Bugzilla::Bug;
use Bugzilla::User;
use Bugzilla::Util;
use Bugzilla::Error;
use Bugzilla::Config::Common;
use Bugzilla::Config::GroupSecurity;

our $VERSION = '1.0';

################
# Installation #
################

sub db_schema_abstract_schema {
  my ($self, $args) = @_;
  my $schema = $args->{schema};

  $schema->{'longdescs_activity'} = {
    FIELDS => [
      comment_id => {
        TYPE    => 'INT',
        NOTNULL => 1,
        REFERENCES =>
          {TABLE => 'longdescs', COLUMN => 'comment_id', DELETE => 'CASCADE'}
      },
      who => {
        TYPE       => 'INT3',
        NOTNULL    => 1,
        REFERENCES => {TABLE => 'profiles', COLUMN => 'userid', DELETE => 'CASCADE'}
      },
      change_when => {TYPE => 'DATETIME', NOTNULL => 1},
      old_comment => {TYPE => 'LONGTEXT', NOTNULL => 1},
      is_hidden   => {TYPE => 'BOOLEAN',  NOTNULL => 1, DEFAULT => 0},
    ],
    INDEXES => [
      longdescs_activity_comment_id_idx             => ['comment_id'],
      longdescs_activity_change_when_idx            => ['change_when'],
      longdescs_activity_comment_id_change_when_idx => [qw(comment_id change_when)],
    ],
  };
}

sub install_update_db {
  my $dbh = Bugzilla->dbh;
  $dbh->bz_add_column('longdescs', 'edit_count', {TYPE => 'INT3', DEFAULT => 0});

  # Add the new `is_hidden` column to the `longdescs_activity` table, which
  # has been introduced with the extension's version 1.0, defaulting to `true`
  # because existing admin-edited revisions may contain sensitive info
  $dbh->bz_add_column('longdescs_activity', 'is_hidden',
    {TYPE => 'BOOLEAN', NOTNULL => 1, DEFAULT => 1});
}

####################
# Template Methods #
####################

sub page_before_template {
  my ($self, $args) = @_;

  return if $args->{'page_id'} ne 'comment-revisions.html';

  my $vars   = $args->{'vars'};
  my $user   = Bugzilla->user;
  my $params = Bugzilla->input_params;

  my $bug_id = $params->{bug_id};
  my $bug    = Bugzilla::Bug->check($bug_id);

  my $comment_id = $params->{comment_id};

  my ($comment) = grep($_->id == $comment_id, @{$bug->comments});
  if (!$comment || ($comment->is_private && !$user->is_insider)) {
    ThrowUserError("edit_comment_invalid_comment_id", {comment_id => $comment_id});
  }

  $vars->{'bug'}     = $bug;
  $vars->{'comment'} = $comment;
}

##################
# Object Methods #
##################

BEGIN {
  no warnings 'redefine';
  *Bugzilla::Comment::edit_count          = \&_comment_edit_count;
  *Bugzilla::Comment::is_editable_by      = \&_comment_is_editable_by;
  *Bugzilla::Comment::activity            = \&_comment_get_activity;
  *Bugzilla::Comment::update_text         = \&_comment_update_text;
  *Bugzilla::User::can_edit_comments      = \&_user_can_edit_comments;
  *Bugzilla::User::is_edit_comments_admin = \&_user_is_edit_comments_admin;
}

sub _comment_edit_count { return $_[0]->{'edit_count'}; }

sub _comment_is_editable_by {
  my ($self, $user) = @_;
  # Note: Does not verify that the bug is visible or editable by the user; the calling
  # code needs to perform this validation at the bug level.

  # Need to be able to edit comments via group membership
  return 0 unless $user->can_edit_comments;

  # Comment admins can edit any comment
  return 1 if $user->is_edit_comments_admin;

  # Can always edit your own comments
  return 1 if $self->author->id == $user->id;

  # Can edit comment 0 (description) on any bug, if enabled
  return 1 if Bugzilla->params->{allow_global_initial_comment_editing}
    && $self->count == 0;

  # Otherwise not editable
  return 0;
}

sub _comment_get_activity {
  my ($self, $activity_sort_order) = @_;
  my $activity;

  if (!defined $self->{activity}) {
    my $dbh = Bugzilla->dbh;
    my $query
      = 'SELECT longdescs_activity.comment_id AS id, profiles.userid, '
      . $dbh->sql_date_format('longdescs_activity.change_when', '%Y-%m-%d %H:%i:%s')
      . '
                          AS time, longdescs_activity.old_comment AS old,
                          longdescs_activity.is_hidden as is_hidden
                    FROM longdescs_activity
              INNER JOIN profiles
                      ON profiles.userid = longdescs_activity.who
                    WHERE longdescs_activity.comment_id = ?';
    $query .= " ORDER BY longdescs_activity.change_when DESC";
    my $sth = $dbh->prepare($query);
    $sth->execute($self->id);

    # We are shifting each comment activity body 1 back. The reason this
    # has to be done is that the longdescs_activity table stores the comment
    # body that the comment was before the edit, not the actual new version
    # of the comment.
    my @activity;
    my $prev_rev;
    my $count = 0;
    while (my $revision = $sth->fetchrow_hashref()) {
      my $current = $count == 0;
      push(
        @activity,
        {
          author       => Bugzilla::User->new({id => $revision->{userid}, cache => 1}),
          created_time => $revision->{time},
          revised_time => $current ? undef : $prev_rev->{time},
          new          => $current ? $self->body : $prev_rev->{old},
          is_hidden    => $current ? 0 : $prev_rev->{is_hidden},
        }
      );
      $prev_rev = $revision;
      $count++;
    }

    if (@activity) {
      # Store the original comment as the first entry, sorting oldest_to_newest
      push(
        @activity,
        {
          author       => $self->author,
          created_time => $self->creation_ts,
          revised_time => $prev_rev->{time},
          new          => $prev_rev->{old},
          is_hidden    => $prev_rev->{is_hidden},
        }
      );
      @activity = reverse @activity;
    }

    $activity = \@activity;
    $self->{activity} = $activity;

  } else {
    $activity = $self->{activity};
  }

  $activity_sort_order
    ||= Bugzilla->user->settings->{'comment_sort_order'}->{'value'};
  if ($activity_sort_order ne "oldest_to_newest") {
    $activity = [reverse @$activity];
  }
  return $activity;
}

sub _comment_update_text {
  my ($self, $args) = @_;
  my $user = Bugzilla->user;
  my $dbh  = Bugzilla->dbh;

  my $comment_id    = $self->id;
  my $old_text      = $self->body;
  my $new_text      = $args->{text};
  my $timestamp     = $args->{timestamp};
  my $is_hidden     = $args->{is_hidden};
  my $sync_fulltext = $args->{sync_fulltext};

  # Update the `longdescs` (comments) table
  $dbh->do(
    'UPDATE longdescs SET thetext = ?, edit_count = edit_count + 1 WHERE comment_id = ?',
    undef, $new_text, $comment_id
  );
  Bugzilla->memcached->clear({table => 'longdescs', id => $comment_id});

  # Log old comment to the `longdescs_activity` (comment revisions) table
  $dbh->do(
    'INSERT INTO longdescs_activity (comment_id, who, change_when, old_comment, is_hidden)
              VALUES (?, ?, ?, ?, ?)', undef,
    ($comment_id, $user->id, $timestamp, $old_text, $is_hidden)
  );

  # Update comment object
  $self->{thetext} = $new_text;

  # Clear memcached entry of comment 0 authors
  Bugzilla->memcached->clear({ key => 'c0:' . $comment_id });

  # Update fulltext entry if required
  $self->bug->_sync_fulltext(update_comments => 1) if $sync_fulltext;
}

sub _user_can_edit_comments {
  my ($self) = @_;
  # Checks that edit-comments is enabled, and if the user is a member of a group
  # controlling it, or if the user is an edit-comments-admin.

  my $edit_comments_group = Bugzilla->params->{edit_comments_group};

  return $self->{can_edit_comments} //=
    $self->is_edit_comments_admin()
    || ($edit_comments_group && $self->in_group($edit_comments_group));
}

sub _user_is_edit_comments_admin {
  my ($self) = @_;
  # Checks that edit-all-comments is enabled, and if the user is a member of a group
  # controlling it.

  my $edit_comments_admins_group = Bugzilla->params->{edit_comments_admins_group};

  return $self->{is_edit_comments_admin} //=
    $edit_comments_admins_group && $self->in_group($edit_comments_admins_group);
}

#########
# Hooks #
#########

sub object_columns {
  my ($self,  $args)    = @_;
  my ($class, $columns) = @$args{qw(class columns)};
  if ($class->isa('Bugzilla::Comment')) {
    push(@$columns, 'edit_count');
  }
}

sub bug_end_of_update {
  my ($self, $args) = @_;

  # Silently return if not in the proper group or if editing comments is disabled
  my $user = Bugzilla->user;
  return unless $user->can_edit_comments();

  my $params    = Bugzilla->input_params;
  my $dbh       = Bugzilla->dbh;
  my $bug       = $args->{bug};
  my $timestamp = $args->{timestamp} || $dbh->selectrow_array("SELECT NOW()");

  my $updated = 0;
  foreach my $param (grep(/^edit_comment_textarea_/, keys %$params)) {
    my ($comment_id) = $param =~ /edit_comment_textarea_(\d+)$/;
    next if !detaint_natural($comment_id);

    # The comment ID must belong to this bug.
    my ($comment_obj) = grep($_->id == $comment_id, @{$bug->comments});
    next if (!$comment_obj || ($comment_obj->is_private && !$user->is_insider));

    # Check that user can edit the comment.
    next unless $comment_obj->is_editable_by($user);

    my $new_comment = $comment_obj->_check_thetext($params->{$param});
    next if $comment_obj->body eq $new_comment;

    # edit_comments_admins_group members can hide comment revisions where needed
    my $is_hidden
      = (  $user->is_edit_comments_admin
        && defined $params->{"edit_comment_checkbox_$comment_id"}
        && $params->{"edit_comment_checkbox_$comment_id"} == 'on') ? 1 : 0;

    $comment_obj->update_text({
      text          => $new_comment,
      timestamp     => $timestamp,
      is_hidden     => $is_hidden,
      sync_fulltext => 0,
    });
    $updated = 1;
  }

  $bug->_sync_fulltext(update_comments => 1) if $updated;
}

sub inline_history_stream {
  my ($self, $args) = @_;

  # find comment 0 (description) change_set
  my $change_set;
  foreach my $cs (@{ $args->{stream} }) {
    next unless $cs->{comment};
    $change_set = $cs;
    last;
  }
  return unless $change_set;

  # if comment 0 has been edited
  return unless $change_set->{comment}->edit_count;

  my $key = 'c0:' . $change_set->{comment}->id;
  my @editors;
  my $edited_ts;
  my $cached = Bugzilla->memcached->get({ key => $key });

  if (defined $cached) {
    # cache hit

    # comment->edit_count includes admin edits; there's nothing to do if the
    # count of users making _visible_ edits is 1 so we re-check the editor
    # count.
    return if scalar(@{ $cached->{editors} }) == 1;

    # expand users; because this is generally a short list, build user objects
    # individually to leverage object caching rather than new_from_list which
    # doesn't use caching.
    foreach my $user_id (@{ $cached->{editors} }) {
      push @editors, Bugzilla::User->new({ id => $user_id, cache => 1 });
    }

    $edited_ts = $cached->{edited_ts};

  } else {
    # cache miss

    # grab editors and the last edit date from comment activity
    my @editor_ids;
    my %seen;
    foreach my $entry (@{ $change_set->{comment}->activity('newest_to_oldest') }) {
      next if $entry->{is_hidden};
      $edited_ts //= $entry->{created_time};
      my $author_id = $entry->{author}->id;
      next if $seen{$author_id};
      $seen{$author_id} = 1;
      push @editors, $entry->{author};
      push @editor_ids, $author_id;
    }
    if (!exists $seen{$change_set->{comment}->author->id}) {
      push @editors, $change_set->{comment}->author;
      push @editor_ids, $change_set->{comment}->author->id;
    }

    # stored as oldest to newest
    @editors = reverse @editors;
    @editor_ids = reverse @editor_ids;

    # cache
    $cached = {
      editors   => [ @editor_ids ],
      edited_ts => $edited_ts,
    };
    Bugzilla->memcached->set({ key => $key, value => $cached });

    # comment->edit_count includes admin edits; there's nothing to do if the
    # count of users making _visible_ edits is 1 so we re-check the editor
    # count.
    return if scalar(@editor_ids) == 1;
  }

  # populate change-set's editors and edited fields
  push @{ $change_set->{editors} }, @editors;
  $change_set->{edited} = $edited_ts;
}

sub config_modify_panels {
  my ($self, $args) = @_;
  push @{$args->{panels}->{groupsecurity}->{params}},
    {
    name    => 'edit_comments_group',
    type    => 's',
    choices => \&get_all_group_names,
    default => 'editbugs',
    checker => \&check_group
    };
  push @{$args->{panels}->{groupsecurity}->{params}},
    {
    name    => 'edit_comments_admins_group',
    type    => 's',
    choices => \&get_all_group_names,
    default => 'admin',
    checker => \&check_group
    };
  push @{$args->{panels}->{groupsecurity}->{params}},
    {
    name    => 'allow_global_initial_comment_editing',
    type    => 'b',
    default => 1
    };
}

sub get_bug_activity {
  my ($self, $args) = @_;

  return unless $args->{include_comment_activity};

  my $list               = $args->{list};
  my $starttime          = $args->{start_time};
  my $is_insider         = Bugzilla->user->is_insider;
  my $is_comments_admin  = Bugzilla->user->is_edit_comments_admin;
  my $hidden_placeholder = '(Hidden by Administrator)';

  my $query = "SELECT DISTINCT(c.comment_id) from longdescs_activity AS a
      INNER JOIN longdescs AS c ON c.comment_id = a.comment_id AND c.bug_id = ?
    " . ($is_insider ? '' : 'AND c.isprivate = 0');
  my @args = ($args->{bug_id});

  # Only consider changes since $starttime, if given.
  if (defined $starttime) {
    $query .= ' WHERE a.change_when > ?';
    push(@args, $starttime);
  }

  my $edited_comment_ids
    = Bugzilla->dbh->selectcol_arrayref($query, undef, @args);

  foreach my $comment_id (@$edited_comment_ids) {
    my $prev_rev = {};

    foreach my $revision (@{Bugzilla::Comment->new($comment_id)->activity}) {
      # Exclude original comment, because we are interested only in revisions
      if ($revision->{old}) {
        push(@$list, [
          'comment_revision',
          undef,
          undef,
          $revision->{created_time},
          $prev_rev->{is_hidden} && !$is_insider ? $hidden_placeholder : $revision->{old},
          $revision->{is_hidden} && !$is_insider ? $hidden_placeholder : $revision->{new},
          $revision->{author}->{login_name},
          $comment_id
        ]);
      }

      $prev_rev = $revision;
    }
  }
}

sub webservice {
  my ($self, $args) = @_;
  my $dispatch = $args->{dispatch};
  $dispatch->{EditComments} = "Bugzilla::Extension::EditComments::WebService";
}

sub db_sanitize {
  my $dbh = Bugzilla->dbh;
  print "Deleting edited comment histories...\n";
  $dbh->do("DELETE FROM longdescs_activity");
  $dbh->do("UPDATE longdescs SET edit_count=0");
}

__PACKAGE__->NAME;
